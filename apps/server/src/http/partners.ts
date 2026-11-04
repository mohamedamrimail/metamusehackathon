import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { HOUR, limited } from '../lib/ratelimit.ts';
import { connectors, partnerApplications, partnerConversations, partnerCredentials, partnerMatches, partnerMembers, partnerMessages, partnerOffers, partnerReports, partnerRequests, partners, partnerTwins, partnerWebhooks, users, webhookDeliveries } from '../db/schema.ts';
import { createCredentials, ensureTwin, PARTNER_SCOPES } from '../partners/core.ts';
import { emit } from '../partners/webhooks.ts';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';
import { Manifest, OfferInput, RequestInput, WebhookInput } from './partner-api.ts';

// Partner lifecycle around the API (P1, P6, P7): applications, admin review, credentials, quality,
// and the user's side (offers, pause/block, reports, transcripts).

const Application = z.object({
  company: z.string().trim().min(2).max(100), website: z.url().max(200), country: z.string().regex(/^[A-Z]{2}$/),
  contact_name: z.string().trim().min(2).max(80), email: z.email(), category: z.enum(['shopping', 'travel', 'jobs', 'productivity', 'other']),
  intended_use: z.string().trim().min(20).max(2000), requested_scopes: z.array(z.enum(PARTNER_SCOPES)).min(1),
});

/** Quality from approvals, dismissals and reports; under 40 the partner is throttled and flagged (P6). */
export async function qualityOf(deps: AppDeps, partnerId: string) {
  const { db } = deps;
  const reqs = await db.select({ status: partnerRequests.status, n: count() }).from(partnerRequests).where(eq(partnerRequests.partnerId, partnerId)).groupBy(partnerRequests.status);
  const n = (s: string) => reqs.find((r) => r.status === s)?.n ?? 0;
  const offers = await db.select({ id: partnerOffers.id }).from(partnerOffers).where(eq(partnerOffers.partnerId, partnerId));
  const ms = offers.length ? await db.select({ status: partnerMatches.status, n: count() }).from(partnerMatches).where(inArray(partnerMatches.offerId, offers.map((o) => o.id))).groupBy(partnerMatches.status) : [];
  const matches = ms.reduce((a, m) => a + m.n, 0);
  const dismissed = ms.find((m) => m.status === 'dismissed')?.n ?? 0;
  const [{ reports } = { reports: 0 }] = await db.select({ reports: count() }).from(partnerReports).where(eq(partnerReports.partnerId, partnerId));
  const decided = n('approved') + n('declined');
  const approval = decided ? n('approved') / decided : 0.7;
  const dismissal = matches ? dismissed / matches : 0;
  const score = Math.max(0, Math.min(100, Math.round(100 * (0.5 * approval + 0.5 * (1 - dismissal)) - reports * 10)));
  return { score, approval_rate: decided ? Math.round(approval * 100) / 100 : null, dismissal_rate: matches ? Math.round(dismissal * 100) / 100 : null, reports, throttled: score < 40 };
}

export async function partnerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  // --- public: "Become a partner" + the API reference ---
  app.post('/partner-applications', async (req, reply) => {
    if (limited(`partner-app:${req.ip}`, 3, HOUR)) return reply.code(429).send({ error: 'rate_limited' });
    const body = Application.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const d = body.data;
    const [a] = await db.insert(partnerApplications).values({ company: d.company, website: d.website, country: d.country, contactName: d.contact_name, email: d.email.toLowerCase(), category: d.category, intendedUse: d.intended_use, requestedScopes: d.requested_scopes }).returning();
    return reply.code(201).send({ id: a!.id, status: 'pending' });
  });
  app.get('/partner/v1/openapi.json', async () => openApi());

  // --- signed-in users ---
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);

    scope.get('/me/offers', async (req) => {
      const rows = await db.select({ m: partnerMatches, o: partnerOffers, p: partners }).from(partnerMatches)
        .innerJoin(partnerOffers, eq(partnerOffers.id, partnerMatches.offerId)).innerJoin(partners, eq(partners.id, partnerOffers.partnerId))
        .where(eq(partnerMatches.userId, req.user.sub)).orderBy(desc(partnerMatches.createdAt)).limit(50);
      return { offers: rows.filter((r) => r.m.status !== 'dismissed').map((r) => ({ id: r.m.id, partner: r.p.name, partner_slug: r.p.slug, verified: r.p.verified, type: r.o.type, title: r.o.title, description: r.o.description, location: r.o.location, remote: r.o.remote, link: r.o.link, score: r.m.score, reason: r.m.reason, open: r.o.status === 'open' })) };
    });

    scope.post<{ Params: { id: string } }>('/me/offers/:id/dismiss', async (req, reply) => {
      if (!z.uuid().safeParse(req.params.id).success) return reply.code(404).send({ error: 'not_found' });
      const [m] = await db.update(partnerMatches).set({ status: 'dismissed' }).where(and(eq(partnerMatches.id, req.params.id), eq(partnerMatches.userId, req.user.sub))).returning();
      if (!m) return reply.code(404).send({ error: 'not_found' });
      const [o] = await db.select().from(partnerOffers).where(eq(partnerOffers.id, m.offerId));
      await emit(db, o!.partnerId, 'offer.dismissed', { offer_id: o!.id, twin_id: await ensureTwin(db, o!.partnerId, req.user.sub) });
      return { ok: true };
    });

    /** Pause/block a partner: no matching, no conversations, `user.revoked` with only the pseudonymous id. */
    scope.post<{ Params: { slug: string } }>('/me/partners/:slug/block', async (req, reply) => {
      const body = z.object({ blocked: z.boolean() }).safeParse(req.body);
      const [p] = await db.select().from(partners).where(eq(partners.slug, req.params.slug));
      if (!p || !body.success) return reply.code(404).send({ error: 'not_found' });
      const twinId = await ensureTwin(db, p.id, req.user.sub);
      await db.update(partnerTwins).set({ blockedAt: body.data.blocked ? new Date() : null }).where(and(eq(partnerTwins.partnerId, p.id), eq(partnerTwins.userId, req.user.sub)));
      if (body.data.blocked) await emit(db, p.id, 'user.revoked', { twin_id: twinId });
      return { ok: true, blocked: body.data.blocked };
    });

    scope.post<{ Params: { slug: string } }>('/me/partners/:slug/report', async (req, reply) => {
      const body = z.object({ reason: z.string().trim().min(3).max(1000) }).safeParse(req.body);
      const [p] = await db.select().from(partners).where(eq(partners.slug, req.params.slug));
      if (!p || !body.success) return reply.code(p ? 400 : 404).send({ error: p ? 'invalid' : 'not_found' });
      await db.insert(partnerReports).values({ partnerId: p.id, userId: req.user.sub, reason: body.data.reason });
      return { ok: true };
    });

    /** Activity: "Yousoft IT asked your twin 3 questions", with transcripts. */
    scope.get('/me/partner-activity', async (req) => {
      const convs = await db.select({ c: partnerConversations, p: partners, o: partnerOffers }).from(partnerConversations)
        .innerJoin(partners, eq(partners.id, partnerConversations.partnerId)).innerJoin(partnerOffers, eq(partnerOffers.id, partnerConversations.offerId))
        .where(eq(partnerConversations.userId, req.user.sub)).orderBy(desc(partnerConversations.createdAt)).limit(30);
      const out = [];
      for (const r of convs) {
        const msgs = await db.select().from(partnerMessages).where(eq(partnerMessages.conversationId, r.c.id)).orderBy(partnerMessages.createdAt);
        const questions = msgs.filter((m) => m.role === 'partner').length;
        out.push({ id: r.c.id, partner: r.p.name, partner_slug: r.p.slug, offer: r.o.title, at: r.c.createdAt, summary: `${r.p.name} asked your twin ${questions} question${questions === 1 ? '' : 's'}`, transcript: msgs.map((m) => ({ role: m.role, text: m.content, at: m.createdAt })) });
      }
      return { conversations: out };
    });
  });

  // --- admin: applications, partners, credentials, manifests (P1, P7 fallback: admin creates credentials) ---
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);
    scope.addHook('preHandler', async (req, reply) => {
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.user.sub));
      if (!u || !config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).includes(u.email)) return reply.code(403).send({ error: 'not_admin' });
    });

    scope.get('/admin/partners', async () => {
      const apps = await db.select().from(partnerApplications).orderBy(desc(partnerApplications.createdAt));
      const ps = await db.select().from(partners).orderBy(partners.name);
      const creds = await db.select().from(partnerCredentials).where(isNull(partnerCredentials.revokedAt));
      return {
        applications: apps,
        partners: await Promise.all(ps.map(async (p) => ({ ...p, credentials: creds.filter((c) => c.partnerId === p.id).map((c) => ({ client_id: c.clientId, label: c.label, last_used_at: c.lastUsedAt })), quality: await qualityOf(deps, p.id) }))),
        scopes: PARTNER_SCOPES,
      };
    });

    /** Approve: creates the partner (+ its Store entry, unlisted until the manifest is approved). */
    scope.post<{ Params: { id: string } }>('/admin/partner-applications/:id/approve', async (req, reply) => {
      const body = z.object({ scopes: z.array(z.enum(PARTNER_SCOPES)).min(1), note: z.string().max(500).optional() }).safeParse(req.body);
      const [a] = z.uuid().safeParse(req.params.id).success ? await db.select().from(partnerApplications).where(eq(partnerApplications.id, req.params.id)) : [];
      if (!a || !body.success || a.status !== 'pending') return reply.code(400).send({ error: 'invalid' });
      const slug = a.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      const [c] = await db.insert(connectors).values({ slug, name: a.company, type: 'org', category: a.category, tagline: a.intendedUse.slice(0, 110), live: false, scopes: defaultUserScopes(a.company) }).onConflictDoNothing().returning();
      const [p] = await db.insert(partners).values({ slug, name: a.company, website: a.website, scopes: body.data.scopes, connectorId: c?.id ?? null }).returning();
      await db.update(partnerApplications).set({ status: 'approved', reviewNote: body.data.note, partnerId: p!.id }).where(eq(partnerApplications.id, a.id));
      // Invite the contact as a member if they already have an i-persons account.
      const [member] = await db.select({ id: users.id }).from(users).where(eq(users.email, a.email));
      if (member) await db.insert(partnerMembers).values({ partnerId: p!.id, userId: member.id, role: 'owner' }).onConflictDoNothing();
      // HACKATHON: the approval email to the contact is sent by hand for now.
      return { partner: p, credentials: await createCredentials(db, p!.id, 'initial') };
    });
    scope.post<{ Params: { id: string } }>('/admin/partner-applications/:id/reject', async (req, reply) => {
      const body = z.object({ note: z.string().max(500).optional() }).safeParse(req.body ?? {});
      if (!z.uuid().safeParse(req.params.id).success || !body.success) return reply.code(400).send({ error: 'invalid' });
      await db.update(partnerApplications).set({ status: 'rejected', reviewNote: body.data.note }).where(eq(partnerApplications.id, req.params.id));
      return { ok: true };
    });

    scope.patch<{ Params: { id: string } }>('/admin/partners/:id', async (req, reply) => {
      const body = z.object({ status: z.enum(['active', 'suspended']).optional(), verified: z.boolean().optional(), scopes: z.array(z.enum(PARTNER_SCOPES)).optional(), operator_affiliated: z.boolean().optional() }).safeParse(req.body);
      if (!body.success || !z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid' });
      const { operator_affiliated, ...rest } = body.data;
      const [p] = await db.update(partners).set({ ...rest, ...(operator_affiliated !== undefined ? { operatorAffiliated: operator_affiliated } : {}) }).where(eq(partners.id, req.params.id)).returning();
      // Suspended partners disappear from the Store.
      if (p?.connectorId && body.data.status) await db.update(connectors).set({ live: body.data.status === 'active' && Boolean(p.manifest) }).where(eq(connectors.id, p.connectorId));
      if (p?.connectorId && body.data.verified !== undefined) await db.update(connectors).set({ verified: body.data.verified }).where(eq(connectors.id, p.connectorId));
      return { partner: p };
    });
    scope.post<{ Params: { id: string } }>('/admin/partners/:id/credentials', async (req, reply) => {
      if (!z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid' });
      return reply.code(201).send(await createCredentials(db, req.params.id, (req.body as { label?: string } | undefined)?.label));
    });
    scope.delete<{ Params: { clientId: string } }>('/admin/partner-credentials/:clientId', async (req) => {
      await db.update(partnerCredentials).set({ revokedAt: new Date() }).where(eq(partnerCredentials.clientId, req.params.clientId));
      return { ok: true };
    });
    /** Approve the pending manifest: it becomes the partner's live Store entry (P2). */
    scope.post<{ Params: { id: string } }>('/admin/partners/:id/manifest/approve', async (req, reply) => {
      const [p] = z.uuid().safeParse(req.params.id).success ? await db.select().from(partners).where(eq(partners.id, req.params.id)) : [];
      const m = Manifest.safeParse(p?.pendingManifest);
      if (!p || !m.success) return reply.code(400).send({ error: 'no_pending_manifest' });
      const values = { name: m.data.name, type: 'org' as const, category: m.data.category, tagline: m.data.tagline, longDescription: m.data.long_description, capabilities: m.data.capabilities, scopes: userScopesFor(m.data.name, m.data.user_scopes), live: p.status === 'active', verified: p.verified };
      let connectorId = p.connectorId;
      if (connectorId) await db.update(connectors).set(values).where(eq(connectors.id, connectorId));
      else connectorId = (await db.insert(connectors).values({ slug: p.slug, ...values }).returning())[0]!.id;
      const [row] = await db.update(partners).set({ manifest: m.data, pendingManifest: null, connectorId }).where(eq(partners.id, p.id)).returning();
      return { partner: row };
    });
    scope.get<{ Params: { id: string } }>('/admin/partners/:id/deliveries', async (req) => {
      const hooks = await db.select({ id: partnerWebhooks.id }).from(partnerWebhooks).where(eq(partnerWebhooks.partnerId, req.params.id));
      return { deliveries: hooks.length ? await db.select().from(webhookDeliveries).where(inArray(webhookDeliveries.webhookId, hooks.map((h) => h.id))).orderBy(desc(webhookDeliveries.createdAt)).limit(50) : [] };
    });
  });
}

/** User scopes in plain words, as the Store shows them (P3). */
export function userScopesFor(name: string, scopes: string[]) {
  const all = {
    receive_offers: { id: 'receive_offers', label: 'Receive offers', description: `${name} may propose offers to me`, required: true },
    public_profile: { id: 'public_profile', label: 'Talk to my twin', description: `${name}'s assistant may talk to my twin about my shareable facts`, required: false },
    requests: { id: 'requests', label: 'Ask me for things', description: `${name} may ask me for things like an interview or my CV (I always approve)`, required: false },
  } as const;
  return scopes.filter((s): s is keyof typeof all => s in all).map((s) => all[s]);
}
const defaultUserScopes = (name: string) => userScopesFor(name, ['receive_offers', 'public_profile', 'requests']);

/** OpenAPI 3.1 for /partner/v1, from the same zod schemas the API validates with. */
function openApi() {
  const s = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' });
  const auth = [{ bearer: [] }];
  const json = (schema: z.ZodType) => ({ required: true, content: { 'application/json': { schema: s(schema) } } });
  const ok = (description: string) => ({ 200: { description } });
  return {
    openapi: '3.1.0',
    info: { title: 'i-persons Partner API', version: '1.0.0', description: 'Partners talk to twins through pairwise pseudonymous ids. Everything that reaches a user is an approval card; nothing is shared before their yes. Partner content is treated as untrusted.' },
    servers: [{ url: `${config.PUBLIC_URL}/api` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, basic: { type: 'http', scheme: 'basic' } } },
    paths: {
      '/partner/v1/oauth/token': { post: { summary: 'Client-credentials token (15 min)', security: [{ basic: [] }], requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { grant_type: { const: 'client_credentials' } } } } } }, responses: ok('access_token, token_type, expires_in, scope') } },
      '/partner/v1/manifest': { get: { summary: 'Read your manifest', security: auth, responses: ok('manifest + pending') }, put: { summary: 'Submit a manifest (goes to admin review)', security: auth, requestBody: json(Manifest), responses: { 202: { description: 'pending_review' } } } },
      '/partner/v1/offers': { get: { summary: 'List your offers', security: auth, responses: ok('offers') }, post: { summary: 'Create an offer (offers:write); matching starts right away', security: auth, requestBody: json(OfferInput), responses: { 201: { description: 'offer' } } } },
      '/partner/v1/offers/{id}': { get: { summary: 'Read an offer', security: auth, responses: ok('offer') }, patch: { summary: 'Update an offer (re-matches)', security: auth, requestBody: json(OfferInput.partial()), responses: ok('offer') }, delete: { summary: 'Close an offer', security: auth, responses: ok('ok') } },
      '/partner/v1/offers/{id}/matches': { get: { summary: 'Matches among consenting users (matches:read): twin_id, score 0–100, reason', security: auth, responses: ok('matches') } },
      '/partner/v1/twins/{twinId}/conversations': { post: { summary: 'Start a conversation with a matched twin (twins:converse)', security: auth, requestBody: json(z.object({ offer_id: z.uuid() })), responses: { 201: { description: 'conversation' } } } },
      '/partner/v1/conversations/{id}/messages': { post: { summary: 'Send a message; the twin answers from shareable facts only', security: auth, requestBody: json(z.object({ text: z.string().max(2000) })), responses: ok('reply') } },
      '/partner/v1/twins/{twinId}/requests': { post: { summary: 'Ask the user (requests:write): share_cv, share_contact, schedule, custom → an approval card', security: auth, requestBody: json(RequestInput), responses: { 201: { description: 'request' } } } },
      '/partner/v1/requests/{id}': { get: { summary: 'Request status; on approval the shared data, once', security: auth, responses: ok('request') } },
      '/partner/v1/webhooks': { post: { summary: 'Register a webhook (webhooks:manage); the signing secret is returned once', security: auth, requestBody: json(WebhookInput), responses: { 201: { description: 'webhook + secret' } } }, get: { summary: 'List webhooks', security: auth, responses: ok('webhooks') } },
      '/partner/v1/webhooks/{id}': { delete: { summary: 'Delete a webhook', security: auth, responses: ok('ok') } },
    },
  };
}
