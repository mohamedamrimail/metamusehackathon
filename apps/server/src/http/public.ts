import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { avatarAssets, ipersons, reports, users, visitorConversations, visitorMessages } from '../db/schema.ts';
import { HOUR, limited, MIN } from '../lib/ratelimit.ts';
import { firstName, publicFacts, visitorTurn } from '../public/visitor.ts';
import { ownIperson, requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

// Phase 6: the public twin at i-persons.com/@<handle>. Visitors need no account; the owner decides
// what's public, and anything that needs the owner is an approval card.

export const RESERVED_HANDLES = new Set(['admin', 'api', 'app', 'www', 'mail', 'help', 'support', 'about', 'login', 'signup', 'store', 'talk', 'twin', 'activity', 'developers', 'partner', 'partners', 'org', 'i-persons', 'ipersons', 'root', 'system', 'official', 'meta', 'team', 'security', 'privacy', 'terms', 'null', 'undefined']);
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

const ipHash = (ip: string) => createHash('sha256').update(`${config.APP_ENCRYPTION_KEY ?? 'x'}:${ip}`).digest('hex').slice(0, 32);
const tooMany = (reply: FastifyReply) => reply.code(429).send({ error: 'rate_limited', message: 'Slow down a little and try again in a minute.' });

/** A public twin by handle: public only while enabled, for a verified, non-suspended owner. */
export async function publicTwin(db: AppDeps['db'], handle: string) {
  const [row] = await db.select({ ip: ipersons, owner: users }).from(ipersons).innerJoin(users, eq(users.id, ipersons.userId))
    .where(eq(ipersons.handle, handle.toLowerCase()));
  // The seeded judge demo account has no phone but is public on purpose (@demo).
  if (!row || !row.ip.publicEnabled || (!row.owner.phoneE164 && row.owner.accountKind !== 'demo') || row.owner.suspendedAt) return undefined;
  return row;
}

export async function publicRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const twinByHandle = (handle: string) => publicTwin(db, handle);

  /** Files a public twin may show: its avatar's images and cut-outs, and its scene. */
  const publicFiles = async (ip: typeof ipersons.$inferSelect) => {
    const meta = (ip.avatarMeta ?? {}) as { scene?: { url?: string | null } };
    const urls = new Set<string>([ip.avatarUrl ?? '', meta.scene?.url ?? '']);
    if (ip.avatarAssetId) {
      const rows = await db.select().from(avatarAssets).where(eq(avatarAssets.lookId, ip.avatarAssetId));
      if (rows.find((r) => r.variant === 'base')?.imageUrl === ip.avatarUrl) {
        for (const r of rows) {
          urls.add(r.imageUrl);
          const cut = (r.masks as { cutout_url?: string } | null)?.cutout_url;
          if (cut) urls.add(cut);
        }
      }
    }
    return [...urls].filter(Boolean);
  };
  const toPublic = (handle: string, url: string) => url.replace(/^\/api\/media\//, `/api/public/${handle}/media/`);

  app.get<{ Params: { handle: string } }>('/public/:handle', async (req, reply) => {
    const t = await twinByHandle(req.params.handle);
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const { ip, owner } = t;
    const meta = (ip.avatarMeta ?? {}) as { selfie?: string; mouth?: unknown; scene?: { url?: string | null; credit?: string; credit_url?: string } };
    // Same rig as the owner's Talk screen, with file urls served through the public route.
    const rig: { variants: Record<string, { url: string; cutout_url?: string; masks: Record<string, unknown> }> } = { variants: {} };
    if (ip.avatarAssetId) {
      const rows = await db.select().from(avatarAssets).where(eq(avatarAssets.lookId, ip.avatarAssetId));
      if (rows.find((r) => r.variant === 'base')?.imageUrl === ip.avatarUrl) {
        for (const r of rows) {
          const { cutout_url, ...masks } = (r.masks ?? {}) as Record<string, unknown> & { cutout_url?: string };
          rig.variants[r.variant] = { url: toPublic(ip.handle!, r.imageUrl), ...(cutout_url ? { cutout_url: toPublic(ip.handle!, cutout_url) } : {}), masks };
        }
      }
    }
    if (!rig.variants.base && ip.avatarUrl) rig.variants.base = { url: toPublic(ip.handle!, ip.avatarUrl), masks: { mouth: meta.mouth } };
    const allow = ip.visitorAllow as Record<string, boolean>;
    return {
      handle: ip.handle, name: firstName(owner), display_name: ip.displayName, bio: ip.publicBio, greeting: ip.publicGreeting ?? `Hi! I'm ${firstName(owner)}'s i-person. Ask me anything about ${firstName(owner)}, or leave a message.`,
      // A twin without a selfie uses a neutral avatar: say so, so visitors aren't misled (addendum A0).
      neutral_avatar: !meta.selfie, rig: { ...rig, alive: Object.keys(rig.variants).length > 1 },
      scene: meta.scene?.url ? { url: toPublic(ip.handle!, meta.scene.url), credit: meta.scene.credit, credit_url: meta.scene.credit_url } : null,
      allow, open_to_jobs: ip.openToJobs, facts: (await publicFacts(db, ip.id)).map((f) => f.value),
    };
  });

  app.get<{ Params: { handle: string; file: string } }>('/public/:handle/media/:file', async (req, reply) => {
    const t = await twinByHandle(req.params.handle);
    if (!t || !/^[\w-]+\.(jpg|png|webp)$/.test(req.params.file)) return reply.code(404).send({ error: 'not_found' });
    if (!(await publicFiles(t.ip)).includes(`/api/media/${req.params.file}`)) return reply.code(404).send({ error: 'not_found' });
    const path = join(config.UPLOAD_DIR, req.params.file);
    if (!(await stat(path).catch(() => null))) return reply.code(404).send({ error: 'not_found' });
    const type = req.params.file.endsWith('.png') ? 'image/png' : req.params.file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return reply.type(type).header('Cache-Control', 'public, max-age=3600').send(createReadStream(path));
  });

  // --- visitor conversations (token-bound, rate-limited) ---
  const Start = z.object({
    name: z.string().trim().min(1).max(60), email: z.email().max(200).optional().or(z.literal('')), phone: z.string().trim().max(30).optional(),
    website: z.string().max(0).optional(), // honeypot: real people never fill it
  });
  app.post<{ Params: { handle: string } }>('/public/:handle/conversations', async (req, reply) => {
    const t = await twinByHandle(req.params.handle);
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (limited(`visit-start:${req.ip}`, 10, HOUR)) return tooMany(reply);
    const b = Start.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid' });
    const [c] = await db.insert(visitorConversations).values({ ipersonId: t.ip.id, visitorName: b.data.name, visitorEmail: b.data.email || null, visitorPhone: b.data.phone || null, ipHash: ipHash(req.ip) }).returning();
    const token = app.jwt.sign({ cid: c!.id, typ: 'visitor' } as never, { expiresIn: '6h' });
    return reply.code(201).send({ conversation_id: c!.id, token });
  });

  const visitorConv = async (req: FastifyRequest<{ Params: { handle: string; id: string } }>) => {
    try {
      const claims = app.jwt.verify<{ cid?: string; typ?: string }>(String(req.headers['x-visitor-token'] ?? ''));
      if (claims.typ !== 'visitor' || claims.cid !== req.params.id) return undefined;
    } catch {
      return undefined;
    }
    const t = await twinByHandle(req.params.handle);
    const [c] = t ? await db.select().from(visitorConversations).where(and(eq(visitorConversations.id, req.params.id), eq(visitorConversations.ipersonId, t.ip.id))) : [];
    return c;
  };

  app.post<{ Params: { handle: string; id: string } }>('/public/:handle/conversations/:id/messages', async (req, reply) => {
    const c = await visitorConv(req);
    if (!c) return reply.code(401).send({ error: 'invalid_token' });
    if (limited(`visit-msg:${req.ip}`, 20, 10 * MIN) || limited(`visit-handle:${req.params.handle}`, 300, HOUR)) return tooMany(reply);
    const b = z.object({ text: z.string().trim().min(1).max(1000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid' });
    return visitorTurn(deps, c.id, b.data.text);
  });

  app.get<{ Params: { handle: string; id: string } }>('/public/:handle/conversations/:id/messages', async (req, reply) => {
    const c = await visitorConv(req);
    if (!c) return reply.code(401).send({ error: 'invalid_token' });
    const msgs = await db.select().from(visitorMessages).where(and(eq(visitorMessages.conversationId, c.id), inArray(visitorMessages.role, ['visitor', 'twin']))).orderBy(visitorMessages.createdAt);
    return { messages: msgs.map((m) => ({ role: m.role, text: m.content, at: m.createdAt })) };
  });

  app.post<{ Params: { handle: string } }>('/public/:handle/report', async (req, reply) => {
    const [ip] = await db.select().from(ipersons).where(eq(ipersons.handle, req.params.handle.toLowerCase()));
    if (!ip) return reply.code(404).send({ error: 'not_found' });
    if (limited(`report:${req.ip}`, 5, HOUR)) return tooMany(reply);
    const b = z.object({ reason: z.string().trim().min(5).max(2000), contact: z.string().trim().max(200).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid' });
    await db.insert(reports).values({ ipersonId: ip.id, reason: b.data.reason, reporterContact: b.data.contact, ipHash: ipHash(req.ip) });
    return reply.code(201).send({ ok: true });
  });

  // --- owner: public link settings and visitor activity ---
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);

    scope.get<{ Params: { id: string } }>('/ipersons/:id/public', async (req, reply) => {
      const ip = await ownIperson(deps, req, req.params.id);
      if (!ip) return reply.code(404).send({ error: 'not_found' });
      return { handle: ip.handle, enabled: ip.publicEnabled, greeting: ip.publicGreeting, bio: ip.publicBio, allow: ip.visitorAllow, open_to_jobs: ip.openToJobs, visitor_budget_usd: ip.visitorBudgetMicros / 1e6, url: ip.handle ? `${config.PUBLIC_URL}/@${ip.handle}` : null };
    });

    scope.patch<{ Params: { id: string } }>('/ipersons/:id/public', async (req, reply) => {
      const ip = await ownIperson(deps, req, req.params.id);
      if (!ip) return reply.code(404).send({ error: 'not_found' });
      const b = z.object({
        handle: z.string().trim().toLowerCase().regex(HANDLE, '3–30 characters: lowercase letters, digits and dashes').optional(),
        enabled: z.boolean().optional(), greeting: z.string().trim().max(300).nullable().optional(), bio: z.string().trim().max(500).nullable().optional(),
        allow: z.object({ answer: z.boolean(), messages: z.boolean(), meetings: z.boolean() }).optional(),
        open_to_jobs: z.boolean().optional(), visitor_budget_usd: z.number().min(0).max(20).optional(),
      }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid', message: b.error.issues[0]?.message });
      const d = b.data;
      if (d.handle && RESERVED_HANDLES.has(d.handle)) return reply.code(400).send({ error: 'handle_reserved', message: 'That handle is reserved.' });
      if (d.handle) {
        const [taken] = await db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.handle, d.handle));
        if (taken && taken.id !== ip.id) return reply.code(409).send({ error: 'handle_taken', message: 'That handle is taken.' });
      }
      if (d.enabled) {
        const [u] = await db.select({ phone: users.phoneE164 }).from(users).where(eq(users.id, req.user.sub));
        if (!u?.phone) return reply.code(403).send({ error: 'verify_whatsapp_first', message: 'Verify your WhatsApp number first.' });
        if (!(d.handle ?? ip.handle)) return reply.code(400).send({ error: 'handle_required', message: 'Choose a handle first.' });
      }
      const [row] = await db.update(ipersons).set({
        ...(d.handle !== undefined && { handle: d.handle }), ...(d.enabled !== undefined && { publicEnabled: d.enabled }),
        ...(d.greeting !== undefined && { publicGreeting: d.greeting }), ...(d.bio !== undefined && { publicBio: d.bio }),
        ...(d.allow && { visitorAllow: d.allow }), ...(d.open_to_jobs !== undefined && { openToJobs: d.open_to_jobs }),
        ...(d.visitor_budget_usd !== undefined && { visitorBudgetMicros: Math.round(d.visitor_budget_usd * 1e6) }),
      }).where(eq(ipersons.id, ip.id)).returning();
      return { iperson: row };
    });

    /** Activity → "Conversations with others" (Phase 6c), with transcripts and messages left. */
    scope.get('/me/visitor-activity', async (req) => {
      const [ip] = await db.select().from(ipersons).where(eq(ipersons.userId, req.user.sub));
      if (!ip) return { conversations: [] };
      const convs = await db.select().from(visitorConversations).where(eq(visitorConversations.ipersonId, ip.id)).orderBy(desc(visitorConversations.createdAt)).limit(50);
      const out = [];
      for (const c of convs) {
        const msgs = await db.select().from(visitorMessages).where(eq(visitorMessages.conversationId, c.id)).orderBy(visitorMessages.createdAt);
        out.push({ id: c.id, visitor: c.visitorName, email: c.visitorEmail, phone: c.visitorPhone, at: c.createdAt, notes: msgs.filter((m) => m.role === 'note').map((m) => m.content), transcript: msgs.filter((m) => m.role !== 'note').map((m) => ({ role: m.role, text: m.content, at: m.createdAt })) });
      }
      return { conversations: out };
    });

    scope.get('/admin/reports', async (req, reply) => {
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.user.sub));
      if (!u || !config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).includes(u.email)) return reply.code(403).send({ error: 'not_admin' });
      const rows = await db.select({ r: reports, ip: ipersons }).from(reports).leftJoin(ipersons, eq(ipersons.id, reports.ipersonId)).orderBy(desc(reports.createdAt)).limit(200);
      return { reports: rows.map(({ r, ip }) => ({ ...r, handle: ip?.handle ?? null, display_name: ip?.displayName ?? null })) };
    });
    scope.post<{ Params: { id: string } }>('/admin/reports/:id/close', async (req, reply) => {
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.user.sub));
      if (!u || !config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).includes(u.email)) return reply.code(403).send({ error: 'not_admin' });
      if (!z.uuid().safeParse(req.params.id).success) return reply.code(404).send({ error: 'not_found' });
      await db.update(reports).set({ status: 'closed' }).where(eq(reports.id, req.params.id));
      return { ok: true };
    });
  });
}
