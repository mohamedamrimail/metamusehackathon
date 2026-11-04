import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { orgPipeline, partnerMembers, partners, settings, users } from '../db/schema.ts';
import { verifySignature } from '../partners/webhooks.ts';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

// P8: Yousoft's recruiter portal (/org/yousoft). A thin client of the Partner API: every action goes
// through /partner/v1 with Yousoft's own credentials — no private shortcuts into the database. The
// pipeline is driven by the API's signed webhooks.

const SLUG = 'yousoft';
const creds = () => (config.YOUSOFT_CLIENT_ID && config.YOUSOFT_CLIENT_SECRET ? { client_id: config.YOUSOFT_CLIENT_ID, client_secret: config.YOUSOFT_CLIENT_SECRET } : null);
let token: { value: string; until: number } | undefined;

export async function orgRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  /** Calls the public Partner API (in-process, through the same routes and checks as any partner). */
  const api = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown): Promise<{ status: number; body: T }> => {
    const c = creds();
    if (!c) throw new Error('portal credentials missing');
    if (!token || token.until < Date.now() + 30_000) {
      const t = await app.inject({ method: 'POST', url: '/api/partner/v1/oauth/token', payload: { grant_type: 'client_credentials', ...c } });
      if (t.statusCode !== 200) throw new Error(`token ${t.statusCode}`);
      token = { value: t.json().access_token, until: Date.now() + t.json().expires_in * 1000 };
    }
    const r = await app.inject({ method, url: `/api/partner/v1${path}`, headers: { authorization: `Bearer ${token.value}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.json() as T };
  };
  const stage = (offerId: string, twinId: string, s: string, extra: Partial<typeof orgPipeline.$inferInsert> = {}) =>
    db.insert(orgPipeline).values({ partnerSlug: SLUG, offerId, twinId, stage: s, ...extra })
      .onConflictDoUpdate({ target: [orgPipeline.partnerSlug, orgPipeline.offerId, orgPipeline.twinId], set: { stage: s, ...extra, updatedAt: new Date() } });

  /** Registers the portal's webhook once (secret kept in settings, like any partner app would). */
  const ensureWebhook = async () => {
    const [row] = await db.select().from(settings).where(eq(settings.key, `org:${SLUG}:webhook`));
    if (row) return;
    const r = await api<{ secret: string; webhook: { id: string } }>('POST', '/webhooks', { url: `${config.PUBLIC_URL}/api/org/${SLUG}/webhook`, events: [] });
    if (r.status === 201) await db.insert(settings).values({ key: `org:${SLUG}:webhook`, value: { id: r.body.webhook.id, secret: r.body.secret } }).onConflictDoNothing();
  };

  // Webhook receiver (public, signature-checked).
  app.post(`/org/${SLUG}/webhook`, async (req, reply) => {
    const [row] = await db.select().from(settings).where(eq(settings.key, `org:${SLUG}:webhook`));
    const secret = (row?.value as { secret?: string } | undefined)?.secret;
    const body = JSON.stringify(req.body);
    if (!secret || !verifySignature(secret, body, String(req.headers['x-ipersons-signature'] ?? ''))) return reply.code(401).send({ error: 'bad_signature' });
    const e = req.body as { type: string; data: { request_id?: string; twin_id?: string; offer_id?: string; kind?: string; shared?: unknown; score?: number; reason?: string } };
    const [p] = e.data.request_id ? await db.select().from(orgPipeline).where(eq(orgPipeline.requestId, e.data.request_id)) : [];
    if (e.type === 'match.created' && e.data.offer_id && e.data.twin_id) await stage(e.data.offer_id, e.data.twin_id, 'matched', { detail: { score: e.data.score, reason: e.data.reason } });
    else if (p && e.type === 'request.approved') await stage(p.offerId, p.twinId, p.detail && (p.detail as { kind?: string }).kind === 'schedule' ? 'interview_confirmed' : 'contact_shared', { detail: { ...(p.detail as object), shared: e.data.shared } });
    else if (p && e.type === 'request.declined') await stage(p.offerId, p.twinId, 'declined');
    else if (p && e.type === 'request.expired') await stage(p.offerId, p.twinId, 'expired');
    return { ok: true };
  });

  // Portal API for Yousoft members (and admins).
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);
    scope.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      const [p] = await db.select().from(partners).where(eq(partners.slug, SLUG));
      const [m] = p ? await db.select().from(partnerMembers).where(and(eq(partnerMembers.partnerId, p.id), eq(partnerMembers.userId, req.user.sub))) : [];
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.user.sub));
      const admin = u && config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).includes(u.email);
      if (!m && !admin) return reply.code(403).send({ error: 'not_a_member' });
      if (!creds()) return reply.code(503).send({ error: 'portal_not_configured' });
      await ensureWebhook().catch(() => {});
    });

    scope.get(`/org/${SLUG}/jobs`, async () => {
      const r = await api<{ offers: { id: string; title: string; status: string; created_at: string }[] }>('GET', '/offers');
      const jobs = await Promise.all(r.body.offers.map(async (o) => ({ ...o, matches: (await api<{ matches: unknown[] }>('GET', `/offers/${o.id}/matches`)).body.matches?.length ?? 0 })));
      return { jobs };
    });
    scope.post(`/org/${SLUG}/jobs`, async (req, reply) => {
      const r = await api<{ offer: unknown }>('POST', '/offers', { type: 'job', ...(req.body as object) });
      return reply.code(r.status).send(r.body);
    });
    scope.delete<{ Params: { id: string } }>(`/org/${SLUG}/jobs/:id`, async (req, reply) => {
      const r = await api('DELETE', `/offers/${req.params.id}`);
      return reply.code(r.status).send(r.body);
    });
    scope.get<{ Params: { id: string } }>(`/org/${SLUG}/jobs/:id/matches`, async (req) => {
      const r = await api<{ matches: { twin_id: string; score: number; reason: string }[] }>('GET', `/offers/${req.params.id}/matches`);
      const pipe = await db.select().from(orgPipeline).where(and(eq(orgPipeline.partnerSlug, SLUG), eq(orgPipeline.offerId, req.params.id)));
      return { matches: (r.body.matches ?? []).map((m) => ({ ...m, stage: pipe.find((p) => p.twinId === m.twin_id)?.stage ?? 'matched', detail: pipe.find((p) => p.twinId === m.twin_id)?.detail ?? null, conversation_id: pipe.find((p) => p.twinId === m.twin_id)?.conversationId ?? null })) };
    });
    scope.post(`/org/${SLUG}/chat`, async (req, reply) => {
      const b = z.object({ offer_id: z.uuid(), twin_id: z.string(), conversation_id: z.uuid().optional(), text: z.string().trim().min(1).max(2000) }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid' });
      let conversationId = b.data.conversation_id;
      if (!conversationId) {
        const c = await api<{ conversation?: { id: string }; error?: string }>('POST', `/twins/${b.data.twin_id}/conversations`, { offer_id: b.data.offer_id });
        if (!c.body.conversation) return reply.code(c.status).send(c.body);
        conversationId = c.body.conversation.id;
        await stage(b.data.offer_id, b.data.twin_id, 'chatting', { conversationId });
      }
      const m = await api<{ reply?: string; error?: string }>('POST', `/conversations/${conversationId}/messages`, { text: b.data.text });
      return reply.code(m.status).send({ ...m.body, conversation_id: conversationId });
    });
    scope.post(`/org/${SLUG}/requests`, async (req, reply) => {
      const b = z.object({ offer_id: z.uuid(), twin_id: z.string(), kind: z.enum(['schedule', 'share_cv', 'share_contact']), slots: z.array(z.string()).max(5).optional() }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid' });
      const r = await api<{ request?: { id: string }; error?: string }>('POST', `/twins/${b.data.twin_id}/requests`, { kind: b.data.kind, offer_id: b.data.offer_id, slots: b.data.slots });
      if (r.body.request) await stage(b.data.offer_id, b.data.twin_id, b.data.kind === 'schedule' ? 'interview_requested' : 'contact_requested', { requestId: r.body.request.id, detail: { kind: b.data.kind, slots: b.data.slots } });
      return reply.code(r.status).send(r.body);
    });
  });
}
