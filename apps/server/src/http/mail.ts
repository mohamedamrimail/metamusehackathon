import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, like, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import findOpportunities from '../agent/tools/find_opportunities.ts';
import { hasCredit, meteredLlm } from '../billing/credits.ts';
import { extractEmail } from '../mail/extract.ts';
import { config } from '../config.ts';
import { calendarEvents, connections, connectors, contacts, insights, ipersons, profileFacts, users } from '../db/schema.ts';
import { encrypt } from '../lib/crypto.ts';
import { applyWindow, disconnectMailbox, estimate, grants, refreshInsights, storeExtracted, syncMailbox, type MailConfig } from '../mail/sync.ts';
import { authorizeUrl, gmailApi, graphApi, isConfigured, pkce, PROVIDERS, scopesAreReadOnly, tokenRequest, type Extra, type Provider } from '../mail/providers.ts';
import { requireUser } from './auth.ts';
import { refreshIdentifiers } from '../twins/identifiers.ts';
import type { AppDeps } from './deps.ts';

// Mailbox connections (addendum 2, M1–M2) and Insights (M4).

// HACKATHON: pending OAuth states live in memory (10 min); a restart just means "try again".
const pending = new Map<string, { userId: string; provider: Provider; verifier: string; windowMonths: 1 | 2 | 3; expires: number; add?: Extra }>();
const Provider = z.enum(['microsoft', 'google']);
const list = (v: string) => v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Hackathon demo gate: null when mailboxes are open to everyone, else who may connect which addresses. */
export function mailDemo() {
  const mailboxes = list(config.MAIL_DEMO_MAILBOXES);
  return mailboxes.length ? { users: list(config.MAIL_DEMO_USERS), mailboxes } : null;
}
const syncing = new Set<string>();

export async function mailRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  app.addHook('preHandler', requireUser);

  const myIperson = async (userId: string) => (await db.select().from(ipersons).where(eq(ipersons.userId, userId)))[0];
  const myMailbox = async (userId: string, id: string) => {
    const ip = await myIperson(userId);
    if (!ip || !z.uuid().safeParse(id).success) return undefined;
    return (await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.ipersonId, ip.id))))[0];
  };
  const view = (c: typeof connections.$inferSelect) => {
    const cfg = c.config as MailConfig;
    return {
      id: c.id, provider: cfg.provider, email: cfg.email, window_months: cfg.windowMonths, last_sync_at: cfg.lastSyncAt ?? null, status: cfg.status ?? 'idle', progress: cfg.progress ?? null, error: cfg.error ?? null,
      life_scan: Boolean(cfg.lifeScan), import_contacts: Boolean(cfg.importContacts), import_calendar: Boolean(cfg.importCalendar),
      counts: cfg.counts ?? {}, grants: { contacts: grants(cfg, 'contacts'), calendar: grants(cfg, 'calendar') },
    };
  };

  app.get('/connections/mail', async (req) => {
    const ip = await myIperson(req.user.sub);
    const rows = ip ? await db.select().from(connections).where(and(eq(connections.ipersonId, ip.id), or(eq(connections.kind, 'mail_microsoft'), eq(connections.kind, 'mail_google')))) : [];
    const [u] = await db.select({ phone: users.phoneE164, email: users.email }).from(users).where(eq(users.id, req.user.sub));
    const demo = mailDemo();
    return {
      providers: { microsoft: isConfigured('microsoft'), google: isConfigured('google') }, verified: Boolean(u?.phone), mailboxes: rows.map(view),
      // Which mailbox addresses are accepted is only shown to the demo accounts themselves.
      demo: demo ? { allowed: demo.users.includes(u?.email ?? ''), mailboxes: demo.users.includes(u?.email ?? '') ? demo.mailboxes : [] } : null,
    };
  });

  // Browser navigation: redirect to the provider's consent page (read-only scopes, PKCE, signed state).
  app.get<{ Params: { provider: string }; Querystring: { window?: string; add?: string } }>('/connections/:provider/start', async (req, reply) => {
    const provider = Provider.safeParse(req.params.provider);
    if (!provider.success || !isConfigured(provider.data)) return reply.redirect('/store?mailbox=unavailable');
    const [u] = await db.select({ phone: users.phoneE164, email: users.email, onboardedAt: users.onboardedAt }).from(users).where(eq(users.id, req.user.sub));
    const back = (code: string) => `${u?.onboardedAt ? '/store' : '/onboarding'}?mailbox=${code}`;
    if (!u?.phone) return reply.redirect(back('verify_first')); // M1.3: verified users only
    const demo = mailDemo();
    if (demo && !demo.users.includes(u.email)) return reply.redirect(back('demo_only'));
    const windowMonths = ([1, 2, 3].includes(Number(req.query.window)) ? Number(req.query.window) : 1) as 1 | 2 | 3;
    const state = randomBytes(24).toString('base64url');
    const { verifier, challenge } = pkce();
    for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
    // Incremental consent: contacts / calendar only when switched on, plus whatever this mailbox already has.
    const add = z.enum(['contacts', 'calendar']).safeParse(req.query.add).data;
    const ip = await myIperson(req.user.sub);
    const [current] = ip ? await db.select().from(connections).where(and(eq(connections.ipersonId, ip.id), eq(connections.kind, PROVIDERS[provider.data].kind))) : [];
    const cur = current?.config as MailConfig | undefined;
    const extras = (['contacts', 'calendar'] as const).filter((e) => e === add || (cur && grants(cur, e) && (e === 'contacts' ? cur.importContacts : cur.importCalendar)));
    pending.set(state, { userId: req.user.sub, provider: provider.data, verifier, windowMonths: cur?.windowMonths ?? windowMonths, expires: Date.now() + 10 * 60_000, add });
    return reply.redirect(authorizeUrl(provider.data, state, challenge, extras));
  });

  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>('/connections/:provider/callback', async (req, reply) => {
    const p = pending.get(req.query.state ?? '');
    if (p) pending.delete(req.query.state!); // single use
    const [me] = await db.select({ onboardedAt: users.onboardedAt }).from(users).where(eq(users.id, req.user.sub));
    const back = (code: string) => `${me?.onboardedAt ? '/store' : '/onboarding'}?mailbox=${code}`;
    if (!p || p.expires < Date.now() || p.userId !== req.user.sub || p.provider !== req.params.provider) return reply.redirect(back('expired'));
    if (req.query.error || !req.query.code) return reply.redirect(back('cancelled'));
    try {
      const t = await tokenRequest(p.provider, { grant_type: 'authorization_code', code: req.query.code, redirect_uri: `${config.PUBLIC_URL}/api/connections/${p.provider}/callback`, code_verifier: p.verifier });
      if (!t.refresh_token) return reply.redirect(back('no_offline_access'));
      // Refuse anything broader than read-only.
      if (t.scope && !scopesAreReadOnly(p.provider, t.scope)) return reply.redirect(back('scope_too_broad'));
      const api = p.provider === 'microsoft' ? graphApi(t.access_token) : gmailApi(t.access_token);
      const email = await api.email().catch(() => '');
      // Demo: a mailbox outside the demo list is never stored (its token is simply dropped).
      const demo = mailDemo();
      if (demo && !demo.mailboxes.includes(email.toLowerCase())) return reply.redirect(back('demo_mailbox'));
      const ip = await myIperson(req.user.sub);
      if (!ip) return reply.redirect('/onboarding');
      const kind = PROVIDERS[p.provider].kind;
      const cfg: MailConfig = {
        provider: p.provider, email, scopes: t.scope ?? PROVIDERS[p.provider].scopes.join(' '), windowMonths: p.windowMonths, status: 'idle',
        ...(p.add === 'contacts' ? { importContacts: true } : p.add === 'calendar' ? { importCalendar: true } : {}),
      };
      // One mailbox per provider per user: reconnecting replaces it.
      const [old] = await db.select().from(connections).where(and(eq(connections.ipersonId, ip.id), eq(connections.kind, kind)));
      if (old) await db.update(connections).set({ config: { ...(old.config as object), ...cfg }, tokenEnc: encrypt(t.refresh_token) }).where(eq(connections.id, old.id));
      else await db.insert(connections).values({ ipersonId: ip.id, kind, config: cfg, tokenEnc: encrypt(t.refresh_token) });
      await refreshIdentifiers(db, req.user.sub).catch(() => {}); // the mailbox address is now proven
      if (p.add && old && !syncing.has(old.id)) {
        // The user just granted contacts / calendar: import right away.
        syncing.add(old.id);
        void syncMailbox(deps, old.id).catch((err) => req.log.warn({ err }, 'import after consent failed')).finally(() => syncing.delete(old.id));
      }
      return reply.redirect(back(p.add ? `${p.add}_on` : 'connected'));
    } catch (err) {
      req.log.warn({ err }, 'mailbox connect failed');
      return reply.redirect(back('failed'));
    }
  });

  app.get<{ Params: { id: string } }>('/connections/mail/:id/estimate', async (req, reply) => {
    const c = await myMailbox(req.user.sub, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    try {
      return await estimate(deps, c.id);
    } catch {
      return reply.code(502).send({ error: 'mailbox_unreachable', message: 'Couldn’t reach your mailbox. Reconnect it.' });
    }
  });

  /** Starts a sync in the background; poll GET /connections/mail for progress. */
  app.post<{ Params: { id: string } }>('/connections/mail/:id/sync', async (req, reply) => {
    const c = await myMailbox(req.user.sub, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (syncing.has(c.id)) return { started: false, already: true };
    syncing.add(c.id);
    const initial = !(c.config as MailConfig).lastSyncAt;
    void syncMailbox(deps, c.id, { initial }).catch((err) => req.log.warn({ err }, 'mail sync failed')).finally(() => syncing.delete(c.id));
    return { started: true, initial };
  });

  app.patch<{ Params: { id: string } }>('/connections/mail/:id', async (req, reply) => {
    const c = await myMailbox(req.user.sub, req.params.id);
    const body = z.object({
      window_months: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      // Three separate opt-ins (jury §4). Switching one off with forget=true deletes what it brought in.
      life_scan: z.boolean().optional(), import_contacts: z.boolean().optional(), import_calendar: z.boolean().optional(),
      forget: z.boolean().default(false),
    }).safeParse(req.body);
    if (!c || !body.success) return reply.code(c ? 400 : 404).send({ error: c ? 'invalid' : 'not_found' });
    const cfg = c.config as MailConfig;
    const d = body.data;
    if (d.window_months) await applyWindow(db, c.id, d.window_months);
    // Contacts / calendar need their own permission first: the client sends the user to the provider.
    for (const [on, what] of [[d.import_contacts, 'contacts'], [d.import_calendar, 'calendar']] as const) {
      if (on && !grants(cfg, what)) return { needs_consent: `/api/connections/${cfg.provider}/start?add=${what}&window=${cfg.windowMonths}` };
    }
    const patch = {
      ...(d.life_scan !== undefined ? { lifeScan: d.life_scan } : {}),
      ...(d.import_contacts !== undefined ? { importContacts: d.import_contacts } : {}),
      ...(d.import_calendar !== undefined ? { importCalendar: d.import_calendar } : {}),
    };
    if (Object.keys(patch).length) await db.update(connections).set({ config: sql`${connections.config} || ${JSON.stringify(patch)}::jsonb` }).where(eq(connections.id, c.id));
    if (d.forget) {
      const mine = eq(contacts.connectionId, c.id);
      if (d.life_scan === false) {
        // People learned from mail go; address-book entries stay, without what mail added.
        await db.delete(contacts).where(and(mine, eq(contacts.inAddressBook, false)));
        await db.update(contacts).set({ relationship: null, label: null, notes: null, mailsTo: 0, mailsFrom: 0, lastContactAt: null }).where(mine);
      }
      if (d.import_contacts === false) {
        await db.delete(contacts).where(and(mine, eq(contacts.inAddressBook, true), sql`${contacts.mailsTo} + ${contacts.mailsFrom} = 0`));
        await db.update(contacts).set({ inAddressBook: false, phones: [], birthday: null }).where(mine);
      }
      if (d.import_calendar === false) await db.delete(calendarEvents).where(eq(calendarEvents.connectionId, c.id));
    }
    if ((d.life_scan || d.import_contacts || d.import_calendar) && !syncing.has(c.id)) {
      syncing.add(c.id);
      void syncMailbox(deps, c.id, { people: d.life_scan }).catch((err) => req.log.warn({ err }, 'mailbox sync failed')).finally(() => syncing.delete(c.id));
    }
    return { ok: true };
  });

  // --- people the twin knows (address book + opt-in mail scan); private to the owner ---

  app.get('/me/contacts', async (req) => {
    const rows = await db.select().from(contacts).where(eq(contacts.userId, req.user.sub))
      .orderBy(sql`case ${contacts.relationship} when 'family' then 0 when 'friend' then 1 when 'colleague' then 2 when 'client' then 3 else 4 end`, sql`${contacts.mailsTo} * 3 + ${contacts.mailsFrom} desc`, contacts.name);
    return { contacts: rows.map((r) => ({ id: r.id, name: r.name, relationship: r.relationship, label: r.label, notes: r.notes, emails: r.emails, birthday: r.birthday, in_address_book: r.inAddressBook, mails: r.mailsTo + r.mailsFrom })) };
  });

  app.delete<{ Params: { id: string } }>('/me/contacts/:id', async (req, reply) => {
    if (!z.uuid().safeParse(req.params.id).success) return reply.code(404).send({ error: 'not_found' });
    await db.delete(contacts).where(and(eq(contacts.id, req.params.id), eq(contacts.userId, req.user.sub)));
    return { ok: true };
  });

  app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>('/connections/mail/:id', async (req, reply) => {
    const c = await myMailbox(req.user.sub, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    await disconnectMailbox(deps, c.id, req.query.purge === '1');
    return { ok: true };
  });

  /** 5a.3 "Paste a confirmation": same extraction as the mailbox, for one pasted email (quick demos). */
  app.post<{ Params: { slug: string } }>('/store/:slug/paste', async (req, reply) => {
    const body = z.object({ text: z.string().trim().min(40).max(20_000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'Paste the whole confirmation email.' });
    const [c] = await db.select().from(connectors).where(eq(connectors.slug, req.params.slug));
    if (!c || c.type !== 'mail') return reply.code(404).send({ error: 'not_found' });
    if (deps.billing && !(await hasCredit(db, req.user.sub))) return reply.code(402).send({ error: 'no_credit', message: 'Your AI credit is used up.' });
    const llm = deps.billing ? meteredLlm(deps.llm, db, req.user.sub, config.META_LLM_MODEL) : deps.llm;
    const x = await extractEmail(llm, { id: 'pasted', from: `pasted@${(c.senderDomains as string[])[0] ?? 'unknown'}`, receivedAt: new Date(), subject: '', text: body.data.text });
    const n = await storeExtracted(db, req.user.sub, c, null, x, new Date());
    const found = await refreshInsights(deps, req.user.sub);
    return { learned: n, insights: found.length };
  });

  // --- Insights (M4) ---
  app.get('/insights', async (req) => {
    const rows = await db.select().from(insights).where(and(eq(insights.userId, req.user.sub), isNull(insights.dismissedAt), or(isNull(insights.validUntil), gt(insights.validUntil, new Date()))))
      .orderBy(desc(insights.confidence));
    return {
      insights: rows.map((i) => ({
        id: i.id, kind: i.kind, title: i.title, body: i.body, group: (i.data as { group?: string }).group ?? 'shopping',
        evidence: `Based on ${(i.evidenceRefs as string[]).length} ${i.kind === 'reorder' || i.kind === 'spending' ? 'order' : 'booking'} email${(i.evidenceRefs as string[]).length === 1 ? '' : 's'}`,
        data: i.data,
      })),
    };
  });

  const myInsight = async (userId: string, id: string) => z.uuid().safeParse(id).success
    ? (await db.select().from(insights).where(and(eq(insights.id, id), eq(insights.userId, userId))))[0] : undefined;

  app.post<{ Params: { id: string } }>('/insights/:id/dismiss', async (req, reply) => {
    const i = await myInsight(req.user.sub, req.params.id);
    if (!i) return reply.code(404).send({ error: 'not_found' });
    await db.update(insights).set({ dismissedAt: new Date() }).where(eq(insights.id, i.id));
    return { ok: true };
  });

  /** "This is wrong": deletes it and the fact learned from it (the related facts lose their footing). */
  app.post<{ Params: { id: string } }>('/insights/:id/wrong', async (req, reply) => {
    const i = await myInsight(req.user.sub, req.params.id);
    if (!i) return reply.code(404).send({ error: 'not_found' });
    const ip = await myIperson(req.user.sub);
    await db.update(insights).set({ dismissedAt: new Date(), confidence: 0 }).where(eq(insights.id, i.id));
    if (ip) await db.delete(profileFacts).where(and(eq(profileFacts.ipersonId, ip.id), eq(profileFacts.source, 'mailbox'), like(profileFacts.key, `mailbox_${i.key.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}%`)));
    return { ok: true };
  });

  /** "Find similar": real web search near the user, with the insight as context (only sourced links). */
  app.post<{ Params: { id: string } }>('/insights/:id/similar', async (req, reply) => {
    const i = await myInsight(req.user.sub, req.params.id);
    const ip = await myIperson(req.user.sub);
    if (!i || !ip) return reply.code(404).send({ error: 'not_found' });
    const [u] = await db.select().from(users).where(eq(users.id, req.user.sub));
    const merchant = (i.data as { merchant?: string }).merchant;
    const [conn] = merchant ? await db.select({ domains: connectors.senderDomains }).from(connectors).where(eq(connectors.name, merchant)) : [];
    const site = (conn?.domains as string[] | undefined)?.[0];
    const llm = deps.billing ? meteredLlm(deps.llm, db, req.user.sub, config.META_LLM_MODEL) : deps.llm;
    const kind = i.kind.startsWith('travel') || i.kind === 'booking_habit' ? 'travel' : 'deal';
    const res = await findOpportunities.execute(
      { db, llm, ipersonId: ip.id, userName: u!.name, timezone: u!.timezone, now: new Date() },
      { kind, query: `Similar to: ${i.title}. ${i.body}${site ? ` Prefer offers on ${site}.` : ''}`, constraints: 'Only real offers with prices shown on the linked page.' },
    );
    return res;
  });
}
