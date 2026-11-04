import { DISCOVERABILITY, TIMES_OF_DAY, TWIN_SCOPES } from '@ipersons/shared';
import { randomBytes } from 'node:crypto';
import { proposedEvent } from '../channels/events.ts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { config } from '../config.ts';
import { actions, contacts, ipersons, profileFacts, twinConnections, users } from '../db/schema.ts';
import { answerPlan, cancelPlan, loadPlan, MAX_PARTICIPANTS, myPlans, PlanError, PlanInput, planRefusal, plansTogether, planSummary, planView, removeOption } from '../twins/plans.ts';
import { countryAllowed, countrySettings } from '../geo/countries.ts';
import { HOUR, limited } from '../lib/ratelimit.ts';
import {
  acceptInvite, firstNameOf, inviteByToken, InviteError, inviteInfos, invitePrefill, recordWhatsappInvite, sendEmailInvite, suppressByToken,
} from '../twins/invites.ts';
import { identifierHmac, lookupHashes, normaliseEmail, normalisePhone } from '../twins/identifiers.ts';
import { matchContacts, pairConnection, visibleMatch } from '../twins/matching.ts';
import { ipersonOf } from '../twins/activity.ts';
import { ConnectionError, ensureContact, factIdsOf, grantsOf, reportConnection, requestConnection, respond, updateMyGrants } from '../twins/connections.ts';
import { twinSettings } from '../twins/settings.ts';
import { contactViews } from '../twins/view.ts';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

/** Public invite routes (no session): the /join page's data and "Don't send me invites again". */
export async function inviteRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  app.get<{ Params: { token: string } }>('/invites/:token', async (req, reply) => {
    if (limited(`invite-view:${req.ip}`, 60, HOUR)) return reply.code(429).send({ error: 'rate_limited' });
    const found = await inviteByToken(db, req.params.token);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    const country = await deps.geo(req.ip, req.headers);
    const allowed = countryAllowed(await countrySettings(db), country) || (await twinSettings(db)).invitesBypassCountry;
    // Only the inviter's first name: nothing else about them or the contact.
    return { inviter: firstNameOf(found.inviter.name), valid: found.valid, country_allowed: allowed, country };
  });

  const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `<body style="font-family:system-ui,sans-serif;background:#050507;color:#f5f6f8;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px"><main style="max-width:28rem;text-align:center">${body}</main></body>`;
  app.get<{ Params: { token: string } }>('/invites/:token/unsubscribe', async (req, reply) => {
    const found = await inviteByToken(db, req.params.token, new Date(0));
    reply.type('text/html; charset=utf-8');
    if (!found?.invite.emailHmac) return reply.code(404).send(page('i-persons', '<p>This link is not valid.</p>'));
    return page('No more invites', `<h1 style="font-size:1.3rem">Stop i-persons invites?</h1><p>No one on i-persons will be able to send an invite to this email address again.</p>`
      + `<form method="post"><button style="padding:.7rem 1.4rem;border-radius:99px;border:0;font-size:1rem">Don't send me invites again</button></form>`);
  });
  // RFC 8058 one-click (mail clients POST here) and the button above.
  app.post<{ Params: { token: string } }>('/invites/:token/unsubscribe', async (req, reply) => {
    const ok = await suppressByToken(db, req.params.token);
    reply.type('text/html; charset=utf-8');
    return ok ? page('Done', '<p>Done. You will not get i-persons invites again.</p>') : reply.code(404).send(page('i-persons', '<p>This link is not valid.</p>'));
  });
}

// Contacts page API (docs/twin-to-twin.md): who of my contacts has an i-person, invites, twin connections.
// Contacts are private to their owner: every route here is scoped to the signed-in user.

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

export async function contactRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  app.addHook('preHandler', requireUser);

  const ownContact = async (userId: string, id: string) => z.uuid().safeParse(id).success
    ? (await db.select().from(contacts).where(and(eq(contacts.id, id), eq(contacts.userId, userId))))[0] : undefined;

  /** Sheet-only details: plans made together, and for a connected contact the permissions on both sides. */
  const sheetExtras = async (userId: string, c: typeof contacts.$inferSelect): Promise<Record<string, unknown>> => {
    const other = c.hasIperson && c.matchedUserId && (await visibleMatch(db, userId, c.matchedUserId)) ? c.matchedUserId : null;
    if (!other) return { plans: [] };
    const conn = await pairConnection(db, userId, other);
    const plans = await sheetPlans(userId, other);
    if (conn?.status !== 'active') return { plans };
    const ip = await ipersonOf(db, userId);
    // My own facts I could share for planning (never the other side's).
    const facts = ip ? await db.select({ id: profileFacts.id, category: profileFacts.category, key: profileFacts.key, value: profileFacts.value }).from(profileFacts)
      .where(and(eq(profileFacts.ipersonId, ip), inArray(profileFacts.category, ['preference', 'routine', 'constraint']))) : [];
    return {
      plans,
      permissions: {
        mine: grantsOf(conn, userId), theirs: grantsOf(conn, other), my_fact_ids: factIdsOf(conn, userId),
        facts: facts.map((f) => ({ id: f.id, label: `${f.key.replace(/_/g, ' ')}: ${f.value}` })),
      },
    };
  };
  /** Plans with this person (filled in by planning, §5). */
  const sheetPlans = (userId: string, other: string) => plansTogether(db, userId, other);

  // --- §1 discoverability ---
  app.get('/me/discoverability', async (req) => {
    const [u] = await db.select({ d: users.discoverability }).from(users).where(eq(users.id, req.user.sub));
    return { discoverability: u?.d ?? 'contacts' };
  });
  app.put('/me/discoverability', async (req, reply) => {
    const body = z.object({ discoverability: z.enum(DISCOVERABILITY) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    await db.update(users).set({ discoverability: body.data.discoverability }).where(eq(users.id, req.user.sub));
    return { discoverability: body.data.discoverability };
  });

  // --- §2 the list ---
  app.get('/contacts', async (req) => {
    const rows = await db.select().from(contacts).where(eq(contacts.userId, req.user.sub)).orderBy(sql`lower(${contacts.name})`);
    const views = await contactViews(db, req.user.sub, rows, await inviteInfos(db, req.user.sub));
    // Requests from people who aren't (matched) in my contacts, e.g. someone I joined through: their
    // first name and twin name only, so I can accept or decline.
    const known = new Set(rows.map((r) => r.matchedUserId).filter(Boolean));
    const incoming = await db.select({ c: twinConnections, name: users.name, twin: ipersons.displayName }).from(twinConnections)
      .innerJoin(users, eq(users.id, twinConnections.requesterId)).leftJoin(ipersons, eq(ipersons.userId, twinConnections.requesterId))
      .where(and(eq(twinConnections.recipientId, req.user.sub), eq(twinConnections.status, 'pending')));
    const requests = incoming.filter((r) => !known.has(r.c.requesterId)).map((r) => ({ connection_id: r.c.id, name: firstNameOf(r.name), twin_name: r.twin ?? null }));
    return { contacts: views, requests, synced: rows.length > 0 || requests.length > 0 };
  });

  /** The contact sheet: the row plus what only the sheet needs (plans together, my granted permissions). */
  app.get<{ Params: { id: string } }>('/contacts/:id', async (req, reply) => {
    const c = await ownContact(req.user.sub, req.params.id);
    if (!c) return notFound(reply);
    const [view] = await contactViews(db, req.user.sub, [c], await inviteInfos(db, req.user.sub));
    return { contact: view, ...(await sheetExtras(req.user.sub, c)) };
  });

  app.patch<{ Params: { id: string } }>('/contacts/:id', async (req, reply) => {
    const body = z.object({
      name: z.string().trim().min(1).max(80).optional(),
      relationship: z.enum(['family', 'friend', 'colleague', 'client', 'business', 'other']).nullable().optional(),
      label: z.string().trim().max(60).nullable().optional(),
      notes: z.string().trim().max(100).nullable().optional(),
      /** A phone number or email to add, so the person can be found on i-persons (re-matched at once). */
      add_phone: z.string().trim().min(3).max(30).optional(),
      add_email: z.string().trim().min(3).max(120).optional(),
    }).safeParse(req.body);
    const c = await ownContact(req.user.sub, req.params.id);
    if (!c) return notFound(reply);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'Notes can be at most 100 characters.' });
    const { add_phone, add_email, ...fields } = body.data;
    const phones = (c.phones as string[]) ?? [];
    const emails = (c.emails as string[]) ?? [];
    if (add_phone) {
      const owner = await me(req.user.sub);
      const p = normalisePhone(add_phone, owner.phoneCountry ?? owner.country ?? owner.signupCountry);
      if (!p) return reply.code(400).send({ error: 'invalid_phone', message: 'Add the number with its country code, e.g. +216 24 000 000.' });
      if (!phones.map((x) => normalisePhone(x, owner.phoneCountry ?? owner.country)).includes(p)) phones.push(p);
    }
    if (add_email) {
      const e = normaliseEmail(add_email);
      if (!e) return reply.code(400).send({ error: 'invalid_email', message: 'That email address doesn’t look right.' });
      if (!emails.map(normaliseEmail).includes(e)) emails.push(e);
    }
    if (phones.length > 10 || emails.length > 10) return reply.code(400).send({ error: 'too_many', message: 'A contact can have up to 10 numbers and 10 emails.' });
    let [row] = await db.update(contacts).set({ ...fields, ...(add_phone ? { phones } : {}), ...(add_email ? { emails } : {}), updatedAt: new Date() }).where(eq(contacts.id, c.id)).returning();
    if (add_phone || add_email) {
      await matchContacts(db, req.user.sub, [c.id]);
      [row] = await db.select().from(contacts).where(eq(contacts.id, c.id));
    }
    return { contact: (await contactViews(db, req.user.sub, [row!], await inviteInfos(db, req.user.sub)))[0] };
  });

  app.delete<{ Params: { id: string } }>('/contacts/:id', async (req, reply) => {
    const c = await ownContact(req.user.sub, req.params.id);
    if (!c) return notFound(reply);
    await db.delete(contacts).where(eq(contacts.id, c.id));
    return { ok: true };
  });

  // --- §3 invites ---
  const me = async (userId: string) => (await db.select().from(users).where(eq(users.id, userId)))[0]!;

  app.get<{ Params: { id: string } }>('/contacts/:id/invite', async (req, reply) => {
    const c = await ownContact(req.user.sub, req.params.id);
    if (!c) return notFound(reply);
    return invitePrefill(db, await me(req.user.sub), c);
  });

  /** Tapping Send (email) or the WhatsApp button IS the approval; it is logged in Activity. */
  app.post<{ Params: { id: string } }>('/contacts/:id/invite', async (req, reply) => {
    const body = z.object({
      channel: z.enum(['email', 'whatsapp']),
      email: z.string().max(200).optional(),
      message: z.string().max(600).optional(),
      reply_to: z.boolean().optional(),
      remind: z.boolean().optional(),
    }).safeParse(req.body);
    const c = await ownContact(req.user.sub, req.params.id);
    if (!c) return notFound(reply);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    if (limited(`invite:${req.user.sub}`, 30, HOUR)) return reply.code(429).send({ error: 'rate_limited', message: 'Too many invites. Try again later.' });
    const u = await me(req.user.sub);
    try {
      return body.data.channel === 'email'
        ? await sendEmailInvite(db, u, c, { email: body.data.email ?? (c.emails as string[])[0] ?? '', message: body.data.message, replyTo: body.data.reply_to, remind: body.data.remind })
        : await recordWhatsappInvite(db, u, c, { message: body.data.message, remind: body.data.remind });
    } catch (err) {
      if (err instanceof InviteError) return reply.code(409).send({ error: 'refused', message: err.message });
      req.log.warn({ err }, 'invite failed');
      return reply.code(502).send({ error: 'send_failed', message: 'The invite could not be sent right now. Try again later.' });
    }
  });

  /** Called by the web right after sign-up from a /join/<token> link (OAuth sign-ups pass it along too). */
  app.post<{ Params: { token: string } }>('/invites/:token/accept', async (req) => ({ accepted: await acceptInvite(db, req.params.token, req.user.sub) }));

  // --- §4 connecting two i-persons ---
  const connError = (reply: FastifyReply, err: unknown) => {
    if (!(err instanceof ConnectionError)) throw err;
    return err.message === 'not_found' ? notFound(reply) : reply.code(409).send({ error: 'refused', message: err.message });
  };

  /** "Connect twins": the tap is the user's yes (logged in Activity); the other side gets a card. */
  app.post<{ Params: { id: string } }>('/contacts/:id/connect', async (req, reply) => {
    const c = await ownContact(req.user.sub, req.params.id);
    if (!c?.hasIperson || !c.matchedUserId) return notFound(reply);
    try {
      const conn = await requestConnection(deps, req.user.sub, c.matchedUserId, { contactName: c.name });
      return { connection_id: conn.id, status: 'requested' };
    } catch (err) { return connError(reply, err); }
  });

  for (const verb of ['accept', 'decline', 'cancel', 'disconnect', 'block', 'unblock'] as const) {
    app.post<{ Params: { id: string } }>(`/twin-connections/:id/${verb}`, async (req, reply) => {
      if (!z.uuid().safeParse(req.params.id).success) return notFound(reply);
      const scopes = z.object({ scopes: z.array(z.enum(TWIN_SCOPES)).optional() }).safeParse(req.body ?? {});
      try {
        const row = await respond(deps, req.user.sub, req.params.id, verb, { scopes: scopes.success ? scopes.data.scopes : undefined });
        return { status: row.status };
      } catch (err) { return connError(reply, err); }
    });
  }

  /** My side's permissions: scopes and the facts my twin may share under `preferences`. */
  app.patch<{ Params: { id: string } }>('/twin-connections/:id', async (req, reply) => {
    const body = z.object({ scopes: z.array(z.enum(TWIN_SCOPES)).optional(), fact_ids: z.array(z.uuid()).max(30).optional() }).safeParse(req.body);
    if (!body.success || !z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid' });
    try {
      const row = await updateMyGrants(db, req.user.sub, req.params.id, body.data);
      return { mine: grantsOf(row, req.user.sub), my_fact_ids: factIdsOf(row, req.user.sub) };
    } catch (err) { return connError(reply, err); }
  });

  app.post<{ Params: { id: string } }>('/twin-connections/:id/report', async (req, reply) => {
    const body = z.object({ reason: z.string().trim().min(3).max(1000) }).safeParse(req.body);
    if (!body.success || !z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid' });
    try {
      await reportConnection(deps, req.user.sub, req.params.id, body.data.reason);
      return { ok: true, blocked: true };
    } catch (err) { return connError(reply, err); }
  });

  // --- §5 planning ---
  const planError = (reply: FastifyReply, err: unknown) => {
    if (!(err instanceof PlanError)) throw err;
    return err.message === 'not_found' ? notFound(reply) : reply.code(409).send({ error: 'refused', message: err.message });
  };
  /** My open card for this plan (its id drives Approve/Decline on the page through /actions/:id/confirm). */
  const myCard = async (userId: string, sessionId: string) => {
    const ip = await ipersonOf(db, userId);
    if (!ip) return null;
    const [a] = await db.select({ id: actions.id, kind: sql<string>`${actions.args}->>'kind'`, summary: actions.summary }).from(actions)
      .where(and(eq(actions.ipersonId, ip), eq(actions.tool, 'twin_request'), eq(actions.status, 'proposed'), sql`${actions.args}->>'session_id' = ${sessionId}`));
    return a ?? null;
  };

  /**
   * The Plan wizard. Creates the first card for the requester ("Ask Sami's i-person for coffee…?"); Approve
   * (POST /actions/:id/confirm) runs plan_with_contacts like any write action.
   */
  app.post('/plans', async (req, reply) => {
    const body = PlanInput.extend({ contacts: z.array(z.uuid()).min(1).max(MAX_PARTICIPANTS) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const refusal = await planRefusal(db, req.user.sub, body.data);
    if (refusal) return reply.code(409).send({ error: 'refused', message: refusal });
    const names = (await db.select({ id: contacts.id, name: contacts.name }).from(contacts).where(and(eq(contacts.userId, req.user.sub), inArray(contacts.id, body.data.contacts))));
    const ip = await ipersonOf(db, req.user.sub);
    if (!ip) return notFound(reply);
    const conversationId = await deps.runtime.conversationFor(ip, 'web');
    const [action] = await db.insert(actions).values({
      ipersonId: ip, conversationId, tool: 'plan_with_contacts', args: body.data, risk: 'write', status: 'proposed',
      summary: planSummary(body.data, body.data.contacts.map((id) => names.find((n) => n.id === id)?.name ?? 'your contact')),
      confirmToken: randomBytes(18).toString('base64url'), expiresAt: new Date(Date.now() + 30 * 60_000),
    }).returning();
    deps.bus.publish(ip, proposedEvent(action!));
    return { action_id: action!.id, summary: action!.summary };
  });

  app.get('/plans', async (req) => ({ plans: await myPlans(db, req.user.sub) }));

  app.get<{ Params: { id: string } }>('/plans/:id', async (req, reply) => {
    if (!z.uuid().safeParse(req.params.id).success) return notFound(reply);
    const v = await planView(db, req.user.sub, req.params.id);
    return v ? { plan: v, card: await myCard(req.user.sub, v.id) } : notFound(reply);
  });

  /** A participant's answer: times (one for 1:1, any that work for groups) + a place, decline, or one counter. */
  app.post<{ Params: { id: string } }>('/plans/:id/answer', async (req, reply) => {
    const body = z.union([
      z.object({ slot_option_ids: z.array(z.uuid()).min(1).max(3), place_option_id: z.uuid().optional() }),
      z.object({ decline: z.literal(true) }),
      z.object({ counter: z.object({ date_from: z.string(), date_to: z.string(), time_of_day: z.enum(TIMES_OF_DAY).optional() }) }),
    ]).safeParse(req.body);
    if (!body.success || !z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid' });
    try {
      return await answerPlan(deps, req.user.sub, req.params.id, body.data);
    } catch (err) { return planError(reply, err); }
  });

  /** The creator removes options before sending them. */
  app.patch<{ Params: { id: string; optionId: string } }>('/plans/:id/options/:optionId', async (req, reply) => {
    const body = z.object({ removed: z.boolean() }).safeParse(req.body);
    if (!body.success || !z.uuid().safeParse(req.params.id).success || !z.uuid().safeParse(req.params.optionId).success) return reply.code(400).send({ error: 'invalid' });
    try {
      await removeOption(db, req.user.sub, req.params.id, req.params.optionId, body.data.removed);
      return { plan: await planView(db, req.user.sub, req.params.id) };
    } catch (err) { return planError(reply, err); }
  });

  app.post<{ Params: { id: string } }>('/plans/:id/cancel', async (req, reply) => {
    if (!z.uuid().safeParse(req.params.id).success) return notFound(reply);
    const v = await planView(db, req.user.sub, req.params.id);
    if (v?.role !== 'creator') return notFound(reply);
    await cancelPlan(deps, req.user.sub, v.id);
    return { ok: true };
  });

  /** Block and report from a plan card (a participant about the person who asked). */
  app.post<{ Params: { id: string } }>('/plans/:id/report', async (req, reply) => {
    const body = z.object({ reason: z.string().trim().min(3).max(1000) }).safeParse(req.body);
    if (!body.success || !z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid' });
    const plan = await loadPlan(db, req.params.id);
    if (!plan || !plan.participants.some((p) => p.userId === req.user.sub)) return notFound(reply);
    const conn = await pairConnection(db, req.user.sub, plan.session.creatorId);
    if (!conn) return notFound(reply);
    if (plan.participants.find((p) => p.userId === req.user.sub)?.status === 'invited') await answerPlan(deps, req.user.sub, plan.session.id, { decline: true }).catch(() => {});
    await reportConnection(deps, req.user.sub, conn.id, `plan ${plan.session.id}: ${body.data.reason}`);
    return { ok: true, blocked: true };
  });

  /** Re-check now which contacts have an i-person (also runs after every sync and nightly). */
  app.post('/contacts/match', async (req) => ({ on_ipersons: await matchContacts(db, req.user.sub) }));

  // --- Find someone on i-persons without syncing an address book or mailbox ---
  // By WhatsApp number or email: only an identifier the person verified, and only if they let contacts find them
  // (the same rule as contact matching). By name or @handle: public twins only. Never a directory of everyone.
  const lookup = async (me: typeof users.$inferSelect, q: string) => {
    const email = normaliseEmail(q);
    const phone = !email && /^[+\d][\d\s().-]{5,}$/.test(q) ? normalisePhone(q, me.phoneCountry ?? me.country ?? me.signupCountry) : null;
    return { email, phone };
  };
  app.get<{ Querystring: { q?: string } }>('/contacts/search', async (req, reply) => {
    const q = (req.query.q ?? '').trim().slice(0, 80);
    if (q.length < 3) return { results: [] };
    if (limited(`contact-search:${req.user.sub}`, 60, HOUR)) return reply.code(429).send({ error: 'rate_limited', message: 'Too many searches. Try again later.' });
    const meRow = await me(req.user.sub);
    const mine = new Set((await db.select({ m: contacts.matchedUserId }).from(contacts).where(eq(contacts.userId, req.user.sub))).map((r) => r.m).filter(Boolean));
    const shown = async (userId: string, via: 'number' | 'email' | 'public') => {
      const [o] = await db.select({ name: users.name, twin: ipersons.displayName, handle: ipersons.handle, pub: ipersons.publicEnabled })
        .from(users).innerJoin(ipersons, eq(ipersons.userId, users.id)).where(eq(users.id, userId));
      if (!o) return null;
      return { name: o.name, twin_name: o.twin, handle: o.pub ? o.handle : null, via, in_contacts: mine.has(userId) };
    };
    const { email, phone } = await lookup(meRow, q);
    if (email || phone) {
      const hash = email ? identifierHmac('email', email) : identifierHmac('phone', phone!);
      const other = (await lookupHashes(db, [hash], req.user.sub)).get(hash);
      const r = other && (await visibleMatch(db, req.user.sub, other)) ? await shown(other, email ? 'email' : 'number') : null;
      return { results: r ? [r] : [], query: email ? { email } : { phone } };
    }
    const like = `%${q.replace(/[%_]/g, '').replace(/^@/, '')}%`;
    const rows = await db.select({ userId: users.id }).from(ipersons).innerJoin(users, eq(users.id, ipersons.userId))
      .where(and(eq(ipersons.publicEnabled, true), eq(ipersons.status, 'active'), sql`${users.suspendedAt} is null`, sql`${users.id} <> ${req.user.sub}`,
        sql`(${ipersons.handle} ilike ${like} or ${ipersons.displayName} ilike ${like} or ${users.name} ilike ${like})`)).limit(8);
    const results = [];
    for (const r of rows) if (await visibleMatch(db, req.user.sub, r.userId)) { const v = await shown(r.userId, 'public'); if (v) results.push(v); }
    return { results };
  });

  /** Adds a contact by hand: from a public twin's @handle, or a name with a WhatsApp number or email (then matched at once). */
  app.post('/contacts', async (req, reply) => {
    const body = z.object({
      name: z.string().trim().min(1).max(80).optional(),
      handle: z.string().trim().max(40).optional(),
      phone: z.string().trim().min(3).max(30).optional(),
      email: z.string().trim().min(3).max(120).optional(),
      relationship: z.enum(['family', 'friend', 'colleague', 'client', 'business', 'other']).optional(),
    }).safeParse(req.body);
    if (!body.success || (!body.data.handle && !body.data.phone && !body.data.email)) return reply.code(400).send({ error: 'invalid', message: 'Add a WhatsApp number, an email or an @handle.' });
    if (limited(`contact-add:${req.user.sub}`, 60, HOUR)) return reply.code(429).send({ error: 'rate_limited', message: 'Too many new contacts. Try again later.' });
    const d = body.data;
    const meRow = await me(req.user.sub);
    let id: string | undefined;
    if (d.handle) {
      const [o] = await db.select({ userId: ipersons.userId }).from(ipersons).where(and(sql`lower(${ipersons.handle}) = ${d.handle.replace(/^@/, '').toLowerCase()}`, eq(ipersons.publicEnabled, true)));
      if (!o || o.userId === req.user.sub || !(await visibleMatch(db, req.user.sub, o.userId))) return reply.code(404).send({ error: 'not_found', message: 'No public i-person with this handle.' });
      id = await ensureContact(db, req.user.sub, o.userId, { name: d.name, relationship: d.relationship ?? null });
    } else {
      const { email, phone } = await lookup(meRow, d.email ?? d.phone ?? '');
      if (!email && !phone) return reply.code(400).send({ error: 'invalid', message: d.email ? 'That email address doesn’t look right.' : 'Add the number with its country code, e.g. +216 24 000 000.' });
      const hash = email ? identifierHmac('email', email) : identifierHmac('phone', phone!);
      const other = (await lookupHashes(db, [hash], req.user.sub)).get(hash);
      const [them] = other ? await db.select({ name: users.name }).from(users).where(eq(users.id, other)) : [];
      const key = email ?? `phone:${phone}`;
      const [existing] = await db.select().from(contacts).where(and(eq(contacts.userId, req.user.sub), eq(contacts.key, key)));
      const name = (d.name || them?.name || email || phone!).slice(0, 80);
      const [row] = existing ? [existing] : await db.insert(contacts).values({
        userId: req.user.sub, key, name, emails: email ? [email] : [], phones: phone ? [phone] : [], relationship: d.relationship ?? null,
      }).returning();
      id = row!.id;
      await matchContacts(db, req.user.sub, [id]);
    }
    const [row] = await db.select().from(contacts).where(eq(contacts.id, id!));
    return reply.code(201).send({ contact: (await contactViews(db, req.user.sub, [row!], await inviteInfos(db, req.user.sub)))[0] });
  });

  /** The other twin's picture, through my contact (so the browser never learns their ids or file names). */
  app.get<{ Params: { id: string } }>('/contacts/:id/twin-avatar', async (req, reply) => {
    const c = await ownContact(req.user.sub, req.params.id);
    if (!c?.hasIperson || !c.matchedUserId || !(await visibleMatch(db, req.user.sub, c.matchedUserId))) return notFound(reply);
    const [ip] = await db.select({ avatar: ipersons.avatarUrl }).from(ipersons).where(eq(ipersons.userId, c.matchedUserId));
    const file = ip?.avatar?.replace(/^\/api\/media\//, '');
    if (!file || !/^[\w-]+\.(jpg|png|webp)$/.test(file)) return notFound(reply);
    const path = join(config.UPLOAD_DIR, file);
    if (!(await stat(path).catch(() => null))) return notFound(reply);
    const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return reply.type(type).header('Cache-Control', 'private, max-age=3600').send(createReadStream(path));
  });
}
