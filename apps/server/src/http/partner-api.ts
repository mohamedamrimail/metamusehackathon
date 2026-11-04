import { and, count, desc, eq, gte } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { partnerConversations, partnerMatches, partnerMessages, partnerOffers, partnerRequests, partners, partnerTwins, partnerWebhooks } from '../db/schema.ts';
import { assertPublicUrl } from '../mcp/client.ts';
import { checkCredentials, rateLimited, twinIdFor, USER_SCOPES, userForTwin, userGrants, type PartnerScope } from '../partners/core.ts';
import { matchOffer, twinReply } from '../partners/matching.ts';
import { createRequest, MAX_PENDING_PER_USER, REQUEST_KINDS } from '../partners/requests.ts';
import { newWebhookSecret, WEBHOOK_EVENTS } from '../partners/webhooks.ts';
import type { AppDeps } from './deps.ts';
import { qualityOf } from './partners.ts';

// Partner API v1 (addendum 3, P5). Partners talk to twins through pseudonymous ids, never to user data
// directly; anything that reaches the user is an approval card.

type Partner = typeof partners.$inferSelect;
const partnerOf = new WeakMap<FastifyRequest, Partner>();
const qualityCache = new Map<string, { at: number; throttled: boolean }>();

export const OfferInput = z.object({
  // venue: a place twins can propose for coffee/dinner/… plans (requirements.accepts_reservations → reservation requests).
  type: z.enum(['job', 'deal', 'event', 'service', 'venue']),
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().min(10).max(5000),
  requirements: z.object({ skills: z.array(z.string().max(60)).max(30).optional(), languages: z.array(z.string().max(30)).max(10).optional(), accepts_reservations: z.boolean().optional(), reservation_url: z.url().max(500).optional() }).default({}),
  location: z.string().max(120).optional(),
  remote: z.boolean().default(false),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(50).default([]),
  valid_until: z.iso.datetime().optional(),
  link: z.url().max(500).optional(),
});
export const Manifest = z.object({
  name: z.string().min(2).max(60), icon_url: z.url().optional(), tagline: z.string().min(3).max(120), long_description: z.string().max(4000).default(''),
  category: z.enum(['shopping', 'travel', 'jobs', 'productivity', 'other']), capabilities: z.array(z.string().max(80)).max(10).default([]),
  user_scopes: z.array(z.enum(USER_SCOPES)).min(1), offer_types: z.array(z.enum(['job', 'deal', 'event', 'service', 'venue'])).default([]),
  mcp_url: z.url().optional(), tools: z.array(z.string().max(60)).max(30).optional(),
});
export const RequestInput = z.object({
  kind: z.enum(REQUEST_KINDS), offer_id: z.uuid().optional(),
  slots: z.array(z.iso.datetime()).max(5).optional(), text: z.string().max(280).optional(),
}).refine((r) => r.kind !== 'schedule' || (r.slots?.length ?? 0) > 0, { message: 'schedule needs slots' })
  .refine((r) => r.kind !== 'custom' || Boolean(r.text), { message: 'custom needs text' });
export const WebhookInput = z.object({ url: z.url().max(500), events: z.array(z.enum(WEBHOOK_EVENTS)).default([]) });

const offerView = (o: typeof partnerOffers.$inferSelect) => ({
  id: o.id, type: o.type, title: o.title, description: o.description, requirements: o.requirements, location: o.location, remote: o.remote,
  countries: o.countries, link: o.link, valid_until: o.validUntil, status: o.status, created_at: o.createdAt,
});

export async function partnerApiRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  // OAuth 2.0 client credentials: Basic auth or form/JSON body. Short-lived (15 min) JWT.
  app.post('/partner/v1/oauth/token', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    let clientId = body.client_id;
    let secret = body.client_secret;
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (basic) [clientId, secret] = Buffer.from(basic, 'base64').toString().split(':') as [string, string];
    if (body.grant_type !== 'client_credentials' || !clientId || !secret) return reply.code(400).send({ error: 'invalid_request' });
    const partner = await checkCredentials(db, clientId, secret);
    if (!partner) return reply.code(401).send({ error: 'invalid_client' });
    if (partner.status !== 'active') return reply.code(403).send({ error: 'partner_suspended' });
    const scopes = partner.scopes as string[];
    // Not a user session (no `sub`, typ "partner"): requireUser refuses it.
    const token = app.jwt.sign({ pid: partner.id, scopes, typ: 'partner' } as never, { expiresIn: '15m' });
    return { access_token: token, token_type: 'Bearer', expires_in: 900, scope: scopes.join(' ') };
  });

  // Every other /partner/v1 route: a valid token, an active partner, the rate limit.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/partner/v1/') || req.url.startsWith('/partner/v1/oauth/') || req.url.startsWith('/partner/v1/openapi')) return;
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    let claims: { pid?: string; typ?: string };
    try {
      claims = app.jwt.verify<{ pid?: string; typ?: string }>(token ?? '');
    } catch {
      return reply.code(401).send({ error: 'invalid_token' });
    }
    if (claims.typ !== 'partner' || !claims.pid) return reply.code(401).send({ error: 'invalid_token' });
    const [partner] = await db.select().from(partners).where(eq(partners.id, claims.pid));
    if (!partner || partner.status !== 'active') return reply.code(403).send({ error: 'partner_suspended' });
    // Low quality (< 40) → throttled to a quarter of the normal rate (P6); recomputed every 5 minutes.
    const q = qualityCache.get(partner.id);
    if (!q || q.at < Date.now() - 300_000) qualityCache.set(partner.id, { at: Date.now(), throttled: (await qualityOf(deps, partner.id)).throttled });
    const perMin = qualityCache.get(partner.id)!.throttled ? Math.max(1, Math.floor(partner.rateLimitPerMin / 4)) : partner.rateLimitPerMin;
    if (rateLimited(partner.id, perMin)) return reply.code(429).send({ error: 'rate_limited' });
    partnerOf.set(req, partner);
  });
  // Scopes are re-read from the partner row on every call, so an admin change applies immediately.
  const need = (req: FastifyRequest, reply: FastifyReply, scope: PartnerScope) => {
    const p = partnerOf.get(req)!;
    if (!(p.scopes as string[]).includes(scope)) { void reply.code(403).send({ error: 'insufficient_scope', needed: scope }); return null; }
    return p;
  };

  // --- manifest (P2): every change waits for admin review ---
  app.get('/partner/v1/manifest', async (req) => {
    const p = partnerOf.get(req)!;
    return { manifest: p.manifest, pending: p.pendingManifest };
  });
  app.put('/partner/v1/manifest', async (req, reply) => {
    const body = Manifest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    await db.update(partners).set({ pendingManifest: body.data }).where(eq(partners.id, partnerOf.get(req)!.id));
    return reply.code(202).send({ status: 'pending_review' });
  });

  // --- offers ---
  app.post('/partner/v1/offers', async (req, reply) => {
    const p = need(req, reply, 'offers:write');
    if (!p) return;
    const body = OfferInput.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const d = body.data;
    const [offer] = await db.insert(partnerOffers).values({ partnerId: p.id, type: d.type, title: d.title, description: d.description, requirements: d.requirements, location: d.location, remote: d.remote, countries: d.countries, link: d.link, validUntil: d.valid_until ? new Date(d.valid_until) : null }).returning();
    void matchOffer(deps, offer!.id).catch((err) => req.log.warn({ err }, 'matching failed'));
    return reply.code(201).send({ offer: offerView(offer!) });
  });
  app.get('/partner/v1/offers', async (req, reply) => {
    const p = need(req, reply, 'offers:write');
    if (!p) return;
    const rows = await db.select().from(partnerOffers).where(eq(partnerOffers.partnerId, p.id)).orderBy(desc(partnerOffers.createdAt)).limit(100);
    return { offers: rows.map(offerView) };
  });
  const ownOffer = async (p: Partner, id: string) => z.uuid().safeParse(id).success
    ? (await db.select().from(partnerOffers).where(and(eq(partnerOffers.id, id), eq(partnerOffers.partnerId, p.id))))[0] : undefined;
  app.get<{ Params: { id: string } }>('/partner/v1/offers/:id', async (req, reply) => {
    const p = need(req, reply, 'offers:write');
    if (!p) return;
    const o = await ownOffer(p, req.params.id);
    return o ? { offer: offerView(o) } : reply.code(404).send({ error: 'not_found' });
  });
  app.patch<{ Params: { id: string } }>('/partner/v1/offers/:id', async (req, reply) => {
    const p = need(req, reply, 'offers:write');
    if (!p) return;
    const o = await ownOffer(p, req.params.id);
    const body = OfferInput.partial().safeParse(req.body);
    if (!o || !body.success) return reply.code(o ? 400 : 404).send({ error: o ? 'invalid' : 'not_found' });
    const d = body.data;
    const [row] = await db.update(partnerOffers).set({ ...(d.title && { title: d.title }), ...(d.description && { description: d.description }), ...(d.requirements && { requirements: d.requirements }), ...(d.location !== undefined && { location: d.location }), ...(d.remote !== undefined && { remote: d.remote }), ...(d.countries && { countries: d.countries }), ...(d.link && { link: d.link }), ...(d.valid_until && { validUntil: new Date(d.valid_until) }), updatedAt: new Date() }).where(eq(partnerOffers.id, o.id)).returning();
    void matchOffer(deps, o.id).catch(() => {});
    return { offer: offerView(row!) };
  });
  app.delete<{ Params: { id: string } }>('/partner/v1/offers/:id', async (req, reply) => {
    const p = need(req, reply, 'offers:write');
    if (!p) return;
    const o = await ownOffer(p, req.params.id);
    if (!o) return reply.code(404).send({ error: 'not_found' });
    await db.update(partnerOffers).set({ status: 'closed', updatedAt: new Date() }).where(eq(partnerOffers.id, o.id));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/partner/v1/offers/:id/matches', async (req, reply) => {
    const p = need(req, reply, 'matches:read');
    if (!p) return;
    const o = await ownOffer(p, req.params.id);
    if (!o) return reply.code(404).send({ error: 'not_found' });
    const rows = await db.select({ m: partnerMatches, t: partnerTwins }).from(partnerMatches)
      .innerJoin(partnerTwins, and(eq(partnerTwins.userId, partnerMatches.userId), eq(partnerTwins.partnerId, p.id)))
      .where(eq(partnerMatches.offerId, o.id));
    const live = [];
    for (const r of rows) {
      if (r.t.blockedAt || r.m.status === 'dismissed' || !(await userGrants(db, p, r.m.userId)).has('receive_offers')) continue;
      // HACKATHON: no public profile switch yet (Phase 6), so no first name or avatar is ever shared.
      live.push({ twin_id: r.t.twinId, score: r.m.score, reason: r.m.reason, matched_at: r.m.createdAt });
    }
    return { matches: live.sort((a, b) => b.score - a.score) };
  });

  // --- conversations with the visitor agent ---
  const twinFor = async (p: Partner, twinId: string, scope: string) => {
    const t = await userForTwin(db, p.id, twinId);
    if (!t || t.blockedAt || !(await userGrants(db, p, t.userId)).has(scope)) return null;
    return t;
  };
  const dailyCount = async (table: typeof partnerConversations | typeof partnerRequests, p: Partner, offerId: string | undefined) => {
    if (!offerId) return 0;
    const since = new Date(Date.now() - 86_400_000);
    const [r] = await db.select({ n: count() }).from(table).where(and(eq(table.partnerId, p.id), eq(table.offerId, offerId), gte(table.createdAt, since)));
    return r?.n ?? 0;
  };

  app.post<{ Params: { twinId: string } }>('/partner/v1/twins/:twinId/conversations', async (req, reply) => {
    const p = need(req, reply, 'twins:converse');
    if (!p) return;
    const body = z.object({ offer_id: z.uuid() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'offer_required' });
    const t = await twinFor(p, req.params.twinId, 'public_profile');
    if (!t) return reply.code(404).send({ error: 'twin_not_available' });
    const o = await ownOffer(p, body.data.offer_id);
    const [m] = o ? await db.select().from(partnerMatches).where(and(eq(partnerMatches.offerId, o.id), eq(partnerMatches.userId, t.userId))) : [];
    if (!o || !m) return reply.code(404).send({ error: 'no_match_for_offer' });
    if ((await dailyCount(partnerConversations, p, o.id)) >= p.dailyCapPerOffer) return reply.code(429).send({ error: 'daily_cap' });
    const [c] = await db.insert(partnerConversations).values({ partnerId: p.id, offerId: o.id, userId: t.userId }).returning();
    return reply.code(201).send({ conversation: { id: c!.id, twin_id: t.twinId, offer_id: o.id } });
  });

  app.post<{ Params: { id: string } }>('/partner/v1/conversations/:id/messages', async (req, reply) => {
    const p = need(req, reply, 'twins:converse');
    if (!p) return;
    const body = z.object({ text: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!body.success || !z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid' });
    const [c] = await db.select().from(partnerConversations).where(and(eq(partnerConversations.id, req.params.id), eq(partnerConversations.partnerId, p.id)));
    if (!c) return reply.code(404).send({ error: 'not_found' });
    // The user may have paused/blocked the partner or withdrawn consent since the conversation began.
    const [twin] = await db.select().from(partnerTwins).where(and(eq(partnerTwins.partnerId, p.id), eq(partnerTwins.userId, c.userId)));
    if (!twin || twin.blockedAt || !(await userGrants(db, p, c.userId)).has('public_profile')) return reply.code(403).send({ error: 'twin_not_available' });
    const [o] = await db.select().from(partnerOffers).where(eq(partnerOffers.id, c.offerId));
    await db.insert(partnerMessages).values({ conversationId: c.id, role: 'partner', content: body.data.text });
    const replyText = await twinReply(deps, c.id, c.userId, o!, p.name);
    return { reply: replyText };
  });

  // --- requests: always an approval card for the user ---
  app.post<{ Params: { twinId: string } }>('/partner/v1/twins/:twinId/requests', async (req, reply) => {
    const p = need(req, reply, 'requests:write');
    if (!p) return;
    const body = RequestInput.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const t = await twinFor(p, req.params.twinId, 'requests');
    if (!t) return reply.code(404).send({ error: 'twin_not_available' });
    const [pending] = await db.select({ n: count() }).from(partnerRequests).where(and(eq(partnerRequests.userId, t.userId), eq(partnerRequests.status, 'pending')));
    if ((pending?.n ?? 0) >= MAX_PENDING_PER_USER) return reply.code(429).send({ error: 'too_many_pending_requests' });
    if ((await dailyCount(partnerRequests, p, body.data.offer_id)) >= p.dailyCapPerOffer) return reply.code(429).send({ error: 'daily_cap' });
    const r = await createRequest(deps, p, t.userId, { kind: body.data.kind, offerId: body.data.offer_id, payload: { slots: body.data.slots, text: body.data.text } });
    return reply.code(201).send({ request: { id: r.id, status: r.status, kind: r.kind } });
  });

  // The partner's own requests, newest first (statuses only; shared data comes from GET /requests/:id).
  app.get<{ Querystring: { offer_id?: string } }>('/partner/v1/requests', async (req, reply) => {
    const p = need(req, reply, 'requests:write');
    if (!p) return;
    const offer = z.uuid().safeParse(req.query.offer_id).data;
    const rows = await db.select().from(partnerRequests)
      .where(and(eq(partnerRequests.partnerId, p.id), ...(offer ? [eq(partnerRequests.offerId, offer)] : []))).orderBy(desc(partnerRequests.createdAt)).limit(100);
    return { requests: rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, offer_id: r.offerId, twin_id: twinIdFor(p.id, r.userId), created_at: r.createdAt, decided_at: r.decidedAt })) };
  });

  app.get<{ Params: { id: string } }>('/partner/v1/requests/:id', async (req, reply) => {
    const p = need(req, reply, 'requests:write');
    if (!p) return;
    if (!z.uuid().safeParse(req.params.id).success) return reply.code(404).send({ error: 'not_found' });
    const [r] = await db.select().from(partnerRequests).where(and(eq(partnerRequests.id, req.params.id), eq(partnerRequests.partnerId, p.id)));
    if (!r) return reply.code(404).send({ error: 'not_found' });
    // Shared data is handed over once (here or in the webhook), then cleared.
    let shared: unknown;
    if (r.status === 'approved' && r.shared && !r.sharedDeliveredAt) {
      shared = r.shared;
      await db.update(partnerRequests).set({ sharedDeliveredAt: new Date(), shared: null }).where(eq(partnerRequests.id, r.id));
    }
    return { request: { id: r.id, kind: r.kind, status: r.status, decided_at: r.decidedAt, ...(shared ? { shared } : {}) } };
  });

  // --- webhooks ---
  app.post('/partner/v1/webhooks', async (req, reply) => {
    const p = need(req, reply, 'webhooks:manage');
    if (!p) return;
    const body = WebhookInput.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    try {
      await assertPublicUrl(body.data.url);
    } catch {
      return reply.code(400).send({ error: 'url_not_allowed', message: 'Webhook URLs must be public HTTPS addresses.' });
    }
    const secret = newWebhookSecret();
    const [h] = await db.insert(partnerWebhooks).values({ partnerId: p.id, url: body.data.url, secret, events: body.data.events }).returning();
    return reply.code(201).send({ webhook: { id: h!.id, url: h!.url, events: h!.events }, secret });
  });
  app.get('/partner/v1/webhooks', async (req, reply) => {
    const p = need(req, reply, 'webhooks:manage');
    if (!p) return;
    const hooks = await db.select().from(partnerWebhooks).where(eq(partnerWebhooks.partnerId, p.id));
    return { webhooks: hooks.map((h) => ({ id: h.id, url: h.url, events: h.events, created_at: h.createdAt })) };
  });
  app.delete<{ Params: { id: string } }>('/partner/v1/webhooks/:id', async (req, reply) => {
    const p = need(req, reply, 'webhooks:manage');
    if (!p || !z.uuid().safeParse(req.params.id).success) return p ? reply.code(404).send({ error: 'not_found' }) : undefined;
    await db.delete(partnerWebhooks).where(and(eq(partnerWebhooks.id, req.params.id), eq(partnerWebhooks.partnerId, p.id)));
    return { ok: true };
  });
}
