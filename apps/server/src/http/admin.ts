import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, gte, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mailTransport } from '../lib/mailer.ts';
import { z } from 'zod';
import { config } from '../config.ts';
import { actions, adminLog, bypassEmails, inviteCodes, ipersons, settings, timeEstimates, users, waitlist } from '../db/schema.ts';
import { clearRuntimeCache, runtimeSettings } from '../lib/settings.ts';
import { approveUser, validApprovalSig } from '../lib/approval.ts';
import { latencySummary } from '../lib/latency.ts';
import { clearCountryCache, countrySettings, type CountrySettings } from '../geo/countries.ts';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';
import { cohorts, growthMetrics, median, metricsSummary, real, realTwins } from '../lib/metrics.ts';
import { timeGivenBack } from '../lib/impact.ts';

// Admin panel API (Part C; more admin areas join here). Admins are the emails in ADMIN_EMAILS.

const Country = z.string().regex(/^[A-Z]{2}$/);
const admins = () => config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export async function adminRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const adminEmail = new WeakMap<FastifyRequest, string>();

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/admin') && !req.url.startsWith('/api/admin')) return;
    await requireUser(req, reply);
    if (reply.sent) return;
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.user.sub));
    if (!u || !admins().includes(u.email)) return reply.code(403).send({ error: 'not_admin' });
    adminEmail.set(req, u.email);
  });
  const log = (req: FastifyRequest, action: string, detail: unknown) =>
    db.insert(adminLog).values({ admin: adminEmail.get(req)!, action, detail });

  app.get('/admin/me', async () => ({ ok: true }));

  // --- countries ---
  app.get('/admin/countries', async () => {
    const waiting = await db.select({ country: waitlist.country, n: count() }).from(waitlist).where(isNull(waitlist.notifiedAt)).groupBy(waitlist.country);
    return { settings: await countrySettings(db), waitlist: waiting.map((w) => ({ country: w.country, count: w.n })) };
  });

  app.put('/admin/countries', async (req, reply) => {
    const body = z.object({
      allowed: z.array(Country).max(250).optional(),
      publicPagesWorldwide: z.boolean().optional(),
      existingUsersKeepAccess: z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const value: CountrySettings = { ...(await countrySettings(db)), ...body.data };
    value.allowed = [...new Set(value.allowed)].sort();
    await db.insert(settings).values({ key: 'countries', value, updatedBy: adminEmail.get(req) })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: adminEmail.get(req), updatedAt: new Date() } });
    clearCountryCache();
    await log(req, 'countries.update', body.data);
    return { settings: value };
  });

  /** "Email the n people waiting in <Country>" — only those who consented and weren't told yet. */
  app.post('/admin/waitlist/notify', async (req, reply) => {
    const body = z.object({ country: Country }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    if (!(await countrySettings(db)).allowed.includes(body.data.country)) return reply.code(409).send({ error: 'country_not_allowed_yet' });
    if (!config.SMTP_URL) return reply.code(503).send({ error: 'smtp_not_configured' });
    const people = await db.select().from(waitlist).where(and(eq(waitlist.country, body.data.country), isNull(waitlist.notifiedAt)));
    const mail = mailTransport(config.SMTP_URL);
    let sent = 0;
    for (const p of people) {
      try {
        await mail.sendMail({
          from: config.SMTP_FROM, to: p.email, subject: 'i-persons is now available in your country',
          text: `Hi${p.name ? ` ${p.name}` : ''},\n\nYou asked us to tell you when i-persons launches in your country: it just did.\nCreate your digital twin at https://i-persons.com\n\n— the i-persons team\n(You get this email once because you joined our waitlist.)`,
        });
        await db.update(waitlist).set({ notifiedAt: new Date() }).where(eq(waitlist.id, p.id));
        sent++;
      } catch (err) {
        req.log.warn({ err }, 'waitlist email failed');
      }
    }
    await log(req, 'waitlist.notify', { country: body.data.country, sent });
    return { sent, of: people.length };
  });

  // --- invite codes and bypass emails ---
  app.get('/admin/invites', async () => ({ invites: await db.select().from(inviteCodes).orderBy(desc(inviteCodes.createdAt)) }));
  app.post('/admin/invites', async (req, reply) => {
    const body = z.object({ note: z.string().max(200).optional(), max_uses: z.number().int().min(1).max(10_000).default(1), expires_days: z.number().int().min(1).max(365).optional(), code: z.string().regex(/^[A-Z0-9-]{4,40}$/).optional(), kind: z.enum(['invite', 'judge', 'session']).default('invite'), cohort: z.string().regex(/^[a-z0-9-]{2,40}$/).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const code = body.data.code ?? `IP-${randomBytes(4).toString('hex').toUpperCase()}`;
    const [row] = await db.insert(inviteCodes).values({
      code, note: body.data.note, maxUses: body.data.max_uses, kind: body.data.kind, cohort: body.data.cohort ?? null,
      expiresAt: body.data.expires_days ? new Date(Date.now() + body.data.expires_days * 86_400_000) : null,
    }).onConflictDoNothing().returning();
    if (!row) return reply.code(409).send({ error: 'code_taken' });
    await log(req, 'invite.create', { code, note: row.note, maxUses: row.maxUses });
    return { invite: row };
  });
  // Change a code's expiry or uses (e.g. end the judges' code after the hackathon).
  app.patch<{ Params: { code: string } }>('/admin/invites/:code', async (req, reply) => {
    const body = z.object({ expires_at: z.iso.datetime().nullable().optional(), max_uses: z.number().int().min(1).max(10_000).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const [row] = await db.update(inviteCodes).set({
      ...(body.data.expires_at !== undefined ? { expiresAt: body.data.expires_at ? new Date(body.data.expires_at) : null } : {}),
      ...(body.data.max_uses ? { maxUses: body.data.max_uses } : {}),
    }).where(eq(inviteCodes.code, req.params.code)).returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    await log(req, 'invite.update', { code: row.code, ...body.data });
    return { invite: row };
  });
  app.delete<{ Params: { code: string } }>('/admin/invites/:code', async (req) => {
    await db.delete(inviteCodes).where(eq(inviteCodes.code, req.params.code));
    await log(req, 'invite.delete', { code: req.params.code });
    return { ok: true };
  });

  app.get('/admin/bypass', async () => ({ emails: await db.select().from(bypassEmails).orderBy(desc(bypassEmails.createdAt)) }));
  app.post('/admin/bypass', async (req, reply) => {
    const body = z.object({ email: z.email().transform((e) => e.toLowerCase()), note: z.string().max(200).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    await db.insert(bypassEmails).values(body.data).onConflictDoNothing();
    await log(req, 'bypass.add', { email: body.data.email });
    return { ok: true };
  });
  app.delete<{ Params: { email: string } }>('/admin/bypass/:email', async (req) => {
    await db.delete(bypassEmails).where(eq(bypassEmails.email, req.params.email.toLowerCase()));
    await log(req, 'bypass.remove', { email: req.params.email });
    return { ok: true };
  });

  // --- metrics (aggregate only) ---
  app.get('/admin/metrics', async () => {
    const byCountry = await db.select({ country: users.signupCountry, n: count() }).from(users).groupBy(users.signupCountry);
    const waiting = await db.select({ country: waitlist.country, n: count() }).from(waitlist).groupBy(waitlist.country);
    const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(users);
    const profile = await db.select({ gender: users.gender, age: users.ageRange, n: count() }).from(users).groupBy(users.gender, users.ageRange);
    return {
      users: total,
      users_by_country: byCountry.map((r) => ({ country: r.country, count: r.n })),
      waitlist_by_country: waiting.map((r) => ({ country: r.country, count: r.n })),
      profiles: profile.map((r) => ({ gender: r.gender, age_range: r.age, count: r.n })),
    };
  });

  // --- users (Phase 4a.3): search, verified, credit, manual top-up, suspend email / account ---
  app.get<{ Querystring: { q?: string; pending?: string } }>('/admin/users', async (req) => {
    const q = (req.query.q ?? '').trim().toLowerCase();
    const search = q ? or(ilike(users.email, `%${q}%`), ilike(users.name, `%${q}%`)) : undefined;
    const rows = await db.select().from(users).where(req.query.pending ? and(search, isNotNull(users.pendingApprovalAt)) : search).orderBy(desc(users.createdAt)).limit(50);
    const day = new Date(Date.now() - 86_400_000);
    return {
      users: await Promise.all(rows.map(async (u) => {
        const [ip] = await db.select({ id: ipersons.id, handle: ipersons.handle }).from(ipersons).where(eq(ipersons.userId, u.id));
        const [mails] = ip ? await db.select({ n: count() }).from(actions).where(and(eq(actions.ipersonId, ip.id), eq(actions.tool, 'send_email'), eq(actions.status, 'done'), gte(actions.decidedAt, day))) : [{ n: 0 }];
        return { id: u.id, email: u.email, name: u.name, kind: u.accountKind, created_at: u.createdAt, verified: Boolean(u.phoneE164), phone: u.phoneE164, country: u.phoneCountry ?? u.signupCountry, credit_usd: u.aiCreditMicros / 1e6, emails_24h: mails?.n ?? 0, email_suspended: Boolean(u.emailSuspendedAt), suspended: Boolean(u.suspendedAt), pending_approval: Boolean(u.pendingApprovalAt), guest: Boolean(u.guestAt), handle: ip?.handle ?? null };
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/topup', async (req, reply) => {
    const body = z.object({ amount_usd: z.number().min(-100).max(100).refine((n) => n !== 0), reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
    if (!body.success || !z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid', message: 'An amount and a reason are required.' });
    const [u] = await db.update(users).set({ aiCreditMicros: sql`${users.aiCreditMicros} + ${Math.round(body.data.amount_usd * 1e6)}` }).where(eq(users.id, req.params.id)).returning();
    if (!u) return reply.code(404).send({ error: 'not_found' });
    await log(req, 'user.topup', { user: u.email, amount_usd: body.data.amount_usd, reason: body.data.reason });
    return { credit_usd: u.aiCreditMicros / 1e6 };
  });

  // Beta: approve an account that waits (also reachable from the request email, see below).
  app.post<{ Params: { id: string } }>('/admin/users/:id/approve', async (req, reply) => {
    if (!z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid' });
    const u = await approveUser(deps, req.params.id);
    if (!u) return reply.code(404).send({ error: 'not_found', message: 'No account waiting with this id.' });
    await log(req, 'user.approve', { user: u.email });
    return { ok: true };
  });

  // The approval email's link: a confirm page with a button (GET never approves, so mail link scanners can't).
  const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;background:#050507;color:#f5f6f8;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px"><main style="max-width:28rem;text-align:center"><h1 style="font-size:1.3rem">${title}</h1>${body}</main></body>`;
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  app.get<{ Params: { id: string }; Querystring: { sig?: string } }>('/approve/:id', async (req, reply) => {
    reply.type('text/html');
    if (!z.uuid().safeParse(req.params.id).success || !validApprovalSig(req.params.id, req.query.sig ?? '')) return reply.code(403).send(page('Link not valid', '<p>Approve the account in the admin panel instead.</p>'));
    const [u] = await db.select().from(users).where(eq(users.id, req.params.id));
    if (!u) return reply.code(404).send(page('Account not found', '<p>It may have been deleted.</p>'));
    if (!u.pendingApprovalAt) return page('Already approved', `<p>${esc(u.name)} &lt;${esc(u.email)}&gt; can use i-persons.</p>`);
    return page('Approve this account?', `<p>${esc(u.name)}<br>${esc(u.email)}${u.phoneE164 ? `<br>${esc(u.phoneE164)}` : ''}</p><form method="post"><input type="hidden" name="sig" value="${esc(req.query.sig!)}"><button style="font-size:1rem;padding:.6rem 1.4rem;border-radius:999px;border:0;background:#fff;color:#000;cursor:pointer">Approve</button></form>`);
  });
  app.post<{ Params: { id: string } }>('/approve/:id', async (req, reply) => {
    reply.type('text/html');
    const sig = String((req.body as { sig?: unknown } | undefined)?.sig ?? '');
    if (!z.uuid().safeParse(req.params.id).success || !validApprovalSig(req.params.id, sig)) return reply.code(403).send(page('Link not valid', ''));
    const u = await approveUser(deps, req.params.id);
    if (u) await db.insert(adminLog).values({ admin: config.APPROVAL_EMAIL, action: 'user.approve', detail: { user: u.email, via: 'email link' } });
    return page(u ? 'Approved' : 'Already approved', '<p>The person has been told and can continue.</p>');
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/suspend', async (req, reply) => {
    const body = z.object({ what: z.enum(['email', 'account']), suspended: z.boolean(), reason: z.string().max(300).optional() }).safeParse(req.body);
    if (!body.success || !z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid' });
    const at = body.data.suspended ? new Date() : null;
    const [u] = await db.update(users).set(body.data.what === 'email' ? { emailSuspendedAt: at } : { suspendedAt: at }).where(eq(users.id, req.params.id)).returning();
    if (!u) return reply.code(404).send({ error: 'not_found' });
    await log(req, `user.${body.data.what}.${body.data.suspended ? 'suspend' : 'restore'}`, { user: u.email, reason: body.data.reason });
    return { ok: true };
  });

  // --- Impact §9: waitlist demand by country, daily growth and sign-ups from share links ---
  app.get<{ Querystring: { days?: string } }>('/admin/waitlist/growth', async (req) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - (days - 1) * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const week = new Date(Date.now() - 7 * 86_400_000);
    const byCountry = (await db.execute(sql`select country, count(*)::int total, count(*) filter (where created_at >= ${week.toISOString()})::int last_7d, count(*) filter (where referred_by is not null)::int from_shares from waitlist group by 1 order by 2 desc`)).rows;
    const daily = (await db.execute(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') "day", count(*)::int n, count(*) filter (where referred_by is not null)::int from_shares from waitlist where created_at >= ${since.toISOString()} group by 1 order by 1`)).rows;
    const [t] = (await db.execute(sql`select count(*)::int total, count(distinct country)::int countries, count(*) filter (where referred_by is not null)::int from_shares from waitlist`)).rows;
    return { totals: t, by_country: byCountry, daily };
  });

  // --- runtime settings (Phase 4a.6): DB overrides .env ---
  app.get('/admin/settings', async () => ({ settings: await runtimeSettings(db) }));
  app.put('/admin/settings', async (req, reply) => {
    const body = z.object({
      freeCreditUsd: z.number().min(0).max(100).optional(), feeRatio: z.number().min(0).max(5).optional(),
      emailPerHour: z.number().int().min(1).max(100).optional(), emailPerDay: z.number().int().min(1).max(1000).optional(),
      showImpactCounter: z.boolean().optional(),
      showCallsPanel: z.boolean().optional(),
      requireApproval: z.boolean().optional(),
      showWaitlistLine: z.boolean().optional(),
      plusPriceUsd: z.number().min(0).max(500).optional(),
      giftPresetsUsd: z.array(z.number().min(1).max(500)).min(1).max(6).optional(),
      guestCreditUsd: z.number().min(0).max(20).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const value = { ...(await runtimeSettings(db)), ...body.data };
    await db.insert(settings).values({ key: 'runtime', value, updatedBy: adminEmail.get(req) })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: adminEmail.get(req), updatedAt: new Date() } });
    clearRuntimeCache();
    await log(req, 'settings.update', body.data);
    return { settings: value };
  });

  // --- daily metrics (Phase 4a.5) + CSV for the submission's traction numbers ---
  // Only real users count: judges, the demo account and admins are left out.
  const daily = async (days: number, cohort?: string) => {
    const real_ = () => real(cohort);
    const realTwins_ = () => realTwins(cohort);
    // The last `days` calendar days (UTC), today included.
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setTime(since.getTime() - (days - 1) * 86_400_000);
    const per = async (q: ReturnType<typeof sql>) => (await db.execute(q)).rows as { d: string; n: string | number }[];
    const series = {
      signups: await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from users where created_at >= ${since} and id in ${real_()} group by 1`),
      verified: await per(sql`select to_char(verified_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from users where verified_at >= ${since} and id in ${real_()} group by 1`),
      avatars: await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, sum((units->>'images')::int) n from ai_usage where kind = 'image' and created_at >= ${since} and user_id in ${real_()} group by 1`),
      turns: await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from messages where role = 'user' and created_at >= ${since} and conversation_id in (select id from conversations where iperson_id in ${realTwins_()}) group by 1`),
      proposed: await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from actions where risk <> 'read' and created_at >= ${since} and iperson_id in ${realTwins_()} group by 1`),
      approved: await per(sql`select to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from actions where risk <> 'read' and status in ('done', 'confirmed', 'failed') and decided_at >= ${since} and iperson_id in ${realTwins_()} group by 1`),
      declined: await per(sql`select to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from actions where status = 'rejected' and decided_at >= ${since} and iperson_id in ${realTwins_()} group by 1`),
      public_chats: await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from visitor_conversations where created_at >= ${since} and iperson_id in ${realTwins_()} group by 1`),
      recruiter_chats: await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from partner_conversations where created_at >= ${since} and user_id in ${real_()} group by 1`),
      active_users: await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, count(distinct user_id) n from ai_usage where created_at >= ${since} and user_id in ${real_()} group by 1`),
      voice_minutes: await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, sum((units->>'seconds')::numeric) / 60 n from ai_usage where kind = 'stt' and created_at >= ${since} and user_id in ${real_()} group by 1`),
      expired: await per(sql`select to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from actions where status = 'expired' and risk <> 'read' and expires_at >= ${since} and iperson_id in ${realTwins_()} group by 1`),
      handoffs: await per(sql`select to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from actions where tool = 'prepare_checkout' and status = 'done' and decided_at >= ${since} and iperson_id in ${realTwins_()} group by 1`),
      partner_requests: await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from partner_requests where created_at >= ${since} and user_id in ${real_()} group by 1`),
      waitlist: await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from waitlist where created_at >= ${since} group by 1`),
      partner_approved: await per(sql`select to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n from partner_requests where status = 'approved' and decided_at >= ${since} and user_id in ${real_()} group by 1`),
      meta_cost_usd: await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, sum(meta_cost_micros) / 1e6 n from ai_usage where kind <> 'tts' and created_at >= ${since} and user_id in ${real_()} group by 1`),
    };
    // Median AI cost per active user per day (Meta model cost).
    const perUser = await per(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, sum(meta_cost_micros) / 1e6 n from ai_usage where created_at >= ${since} and user_id in ${real_()} group by 1, user_id`);
    const medianCost = new Map<string, number>();
    for (const d of new Set(perUser.map((r) => r.d))) medianCost.set(d, Math.round(median(perUser.filter((r) => r.d === d).map((r) => Number(r.n))) * 10000) / 10000);
    // Impact §1: minutes given back per day (completed, approved actions × the estimate valid then).
    const given = new Map<string, number>();
    const tgb = await timeGivenBack(db, { since });
    const history = await db.select().from(timeEstimates);
    for (const ev of tgb.events) {
      const m = history.filter((e) => e.kind === ev.kind && e.validFrom <= ev.at).sort((a, b) => +a.validFrom - +b.validFrom).at(-1)?.minutes ?? 0;
      const d = ev.at.toISOString().slice(0, 10);
      given.set(d, (given.get(d) ?? 0) + m * ev.count);
    }
    const out: Record<string, number | string>[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      const row: Record<string, number | string> = { date: d };
      for (const [k, rows] of Object.entries(series)) row[k] = Number(rows.find((r) => r.d === d)?.n ?? 0);
      const active = Number(row.active_users);
      row.voice_minutes = Math.round(Number(row.voice_minutes) * 10) / 10;
      row.median_cost_per_active_user_usd = medianCost.get(d) ?? 0;
      row.minutes_given_back = Math.round(given.get(d) ?? 0);
      row.cost_per_active_user_usd = active ? Math.round((Number(row.meta_cost_usd) / active) * 10000) / 10000 : 0;
      row.meta_cost_usd = Math.round(Number(row.meta_cost_usd) * 10000) / 10000;
      out.push(row);
    }
    return out;
  };
  app.get<{ Querystring: { cohort?: string } }>('/admin/metrics/summary', async (req) => ({ summary: await metricsSummary(db, req.query.cohort || undefined) }));
  app.get<{ Querystring: { cohort?: string; days?: string } }>('/admin/growth', async (req) => {
    const days = Number(req.query.days) || 0;
    const since = days ? new Date(Date.now() - days * 86_400_000) : undefined;
    const list = await cohorts(db);
    return {
      cohorts: list,
      overall: await growthMetrics(db, { since, cohort: req.query.cohort || undefined }),
      by_cohort: Object.fromEntries(await Promise.all(list.map(async (c) => [c, await growthMetrics(db, { since, cohort: c })] as const))),
      chain: (await db.execute(sql`select count(chain_started_at) started, count(chain_completed_at) completed from users where id in ${real(req.query.cohort || undefined)}`)).rows[0],
    };
  });
  app.get<{ Querystring: { days?: string; cohort?: string } }>('/admin/metrics/daily', async (req) => ({ days: await daily(Math.min(90, Math.max(1, Number(req.query.days) || 14)), req.query.cohort || undefined) }));
  app.get<{ Querystring: { days?: string; cohort?: string } }>('/admin/metrics/daily.csv', async (req, reply) => {
    const rows = await daily(Math.min(90, Math.max(1, Number(req.query.days) || 30)), req.query.cohort || undefined);
    const cols = Object.keys(rows[0] ?? { date: '' });
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n');
    return reply.type('text/csv').header('Content-Disposition', 'attachment; filename="i-persons-metrics.csv"').send(csv);
  });

  // Voice latency per stage, p50/p90 over recent voice turns (lib/latency.ts).
  app.get<{ Querystring: { days?: string } }>('/admin/metrics/latency', async (req) =>
    latencySummary(db, Math.min(90, Math.max(1, Number(req.query.days) || 7))));

  app.get('/admin/log', async () => ({ log: await db.select().from(adminLog).orderBy(desc(adminLog.createdAt)).limit(100) }));
}

