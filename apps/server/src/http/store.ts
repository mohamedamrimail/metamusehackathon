import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { decrypt, encrypt } from '../lib/crypto.ts';
import { actions, connectors, ipersons, partners, userServices, users } from '../db/schema.ts';
import { connectorVisibleTo } from '@ipersons/shared';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

// The Service Store (Phase B): browse services, activate them with plain-words permissions, and
// deactivate. The twin never activates anything itself.

export interface Scope { id: string; label: string; description: string; required?: boolean }
type Connector = typeof connectors.$inferSelect;

const publicConnector = (c: Connector) => ({
  slug: c.slug, name: c.name, type: c.type, category: c.category, icon_url: c.iconUrl, cover_url: c.coverUrl,
  tagline: c.tagline, long_description: c.longDescription, capabilities: c.capabilities as string[], scopes: c.scopes as Scope[],
  featured: c.featured, badge: c.badge, verified: c.verified,
});

/** What happens right after activating, by service type. */
function nextStep(c: Connector) {
  if (c.type === 'mail') return { kind: 'connect_mailbox', text: `Connect your mailbox: your twin reads only emails from ${c.name}, from the last 1–3 months.` };
  if (c.type === 'upload') return { kind: 'upload', text: 'Upload your order history.' };
  if (c.type === 'mcp') return { kind: 'connect_account', text: `Connect your ${c.name} account.` };
  return { kind: 'none', text: `${c.name} can now reach you through your twin. Everything it asks for comes to you first.` };
}

/** The twin's one line after an activation (taglines read as a phrase: "Your stays, upcoming trips…"). */
export const activationLine = (c: { name: string; tagline: string }) =>
  `Thanks! I'm now connected to ${c.name}: ${c.tagline.replace(/^./, (x) => x.toLowerCase())}.`;

export async function storeRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  app.addHook('preHandler', requireUser);

  const logActivity = async (userId: string, tool: string, summary: string, args: object) => {
    const [ip] = await db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.userId, userId));
    if (!ip) return;
    const now = new Date();
    await db.insert(actions).values({ ipersonId: ip.id, tool, args, risk: 'read', status: 'done', summary, confirmToken: `log_${randomBytes(12).toString('hex')}`, expiresAt: now, decidedAt: now });
    return ip.id;
  };

  app.get('/store', async (req) => {
    // DEMO: demo accounts get the neutral demo services instead of real brands (and real users never see those).
    const kind = await accountKind(req.user.sub);
    const all = (await db.select().from(connectors).where(eq(connectors.live, true)).orderBy(asc(connectors.sortOrder), asc(connectors.name)))
      .filter((c) => connectorVisibleTo(c, kind));
    const mine = await db.select().from(userServices).where(eq(userServices.userId, req.user.sub));
    // Disclosure: partners run by the company that operates i-persons say so on their card.
    const affiliated = new Set((await db.select({ c: partners.connectorId }).from(partners).where(eq(partners.operatorAffiliated, true))).map((r) => r.c));
    return {
      categories: ['shopping', 'travel', 'jobs', 'productivity', 'other'],
      services: all.map((c) => {
        const u = mine.find((m) => m.connectorId === c.id);
        return { ...publicConnector(c), operated_by_team: affiliated.has(c.id), active: Boolean(u), granted_scopes: (u?.grantedScopes as string[] | undefined) ?? [], health: u?.health ?? null, status_line: u?.statusLine ?? null };
      }),
    };
  });

  const accountKind = async (userId: string) => (await db.select({ kind: users.accountKind }).from(users).where(eq(users.id, userId)))[0]?.kind;
  const bySlug = async (slug: string, userId: string) => {
    const [c] = await db.select().from(connectors).where(and(eq(connectors.slug, slug), eq(connectors.live, true)));
    return c && connectorVisibleTo(c, await accountKind(userId)) ? c : undefined;
  };

  app.post<{ Params: { slug: string } }>('/store/:slug/activate', async (req, reply) => {
    const c = await bySlug(req.params.slug, req.user.sub);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    // Connecting services needs a verified WhatsApp number (Phase 2.3).
    const [me] = await db.select({ phone: users.phoneE164 }).from(users).where(eq(users.id, req.user.sub));
    if (!me?.phone) return reply.code(403).send({ error: 'verify_whatsapp_first', message: 'Verify your WhatsApp number first (My twin → WhatsApp).' });
    const body = z.object({ scopes: z.array(z.string()).max(20).default([]) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const scopes = c.scopes as Scope[];
    const granted = scopes.filter((s) => s.required || body.data.scopes.includes(s.id)).map((s) => s.id);
    const statusLine = c.type === 'mail' ? 'Connect your mailbox to start' : c.type === 'org' ? `${c.name} can talk to your twin` : null;
    const [row] = await db.insert(userServices).values({ userId: req.user.sub, connectorId: c.id, grantedScopes: granted, health: c.type === 'mail' ? 'needs_attention' : 'ok', statusLine })
      .onConflictDoUpdate({ target: [userServices.userId, userServices.connectorId], set: { grantedScopes: granted, updatedAt: new Date() } }).returning();
    const ipersonId = await logActivity(req.user.sub, 'store_activate', `Activated ${c.name}`, { service: c.slug, scopes: granted });
    const line = activationLine(c);
    if (ipersonId) deps.bus.publish(ipersonId, { type: 'service.activated', name: c.name, line });
    return { service: { ...publicConnector(c), active: true, granted_scopes: row!.grantedScopes, health: row!.health, status_line: row!.statusLine }, next_step: nextStep(c), line };
  });

  app.post<{ Params: { slug: string } }>('/store/:slug/deactivate', async (req, reply) => {
    const c = await bySlug(req.params.slug, req.user.sub);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const [gone] = await db.delete(userServices).where(and(eq(userServices.userId, req.user.sub), eq(userServices.connectorId, c.id))).returning();
    if (!gone) return reply.code(404).send({ error: 'not_active' });
    // HACKATHON: nothing is learned per service yet; mailbox sync (addendum 2) adds its own deletions here.
    await logActivity(req.user.sub, 'store_deactivate', `Deactivated ${c.name}`, { service: c.slug });
    return { ok: true, deleted: ['your activation', 'the permissions you granted'] };
  });

  // --- admin: catalog and icons (admin check as in /admin routes) ---
  const isAdmin = async (userId: string) => {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    return Boolean(u && config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).includes(u.email));
  };
  const Upsert = z.object({
    slug: z.string().regex(/^[a-z0-9-]{2,40}$/), name: z.string().min(1).max(60), type: z.enum(['mail', 'mcp', 'upload', 'org']),
    category: z.enum(['shopping', 'travel', 'jobs', 'productivity', 'other']), tagline: z.string().min(1).max(120),
    long_description: z.string().max(4000).default(''), capabilities: z.array(z.string().max(80)).max(10).default([]),
    scopes: z.array(z.object({ id: z.string().regex(/^[a-z_]{2,40}$/), label: z.string().max(60), description: z.string().max(200), required: z.boolean().optional() })).max(10).default([]),
    sender_domains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(30).default([]),
    featured: z.boolean().default(false), sort_order: z.number().int().default(100), badge: z.enum(['new', 'beta', 'popular']).nullable().default(null),
    verified: z.boolean().default(false), live: z.boolean().default(true),
    // type mcp (Phase 4b): server URL, optional auth header (stored encrypted, never returned), tool allowlist.
    mcp_url: z.url().optional(), mcp_auth: z.string().max(500).optional(), tool_allowlist: z.array(z.string().max(80)).max(50).optional(),
  });
  const connectorView = (c: typeof connectors.$inferSelect) => { const { mcpAuthEnc, ...rest } = c; return { ...rest, mcpAuthSet: Boolean(mcpAuthEnc) }; };
  app.get('/admin/connectors', async (req, reply) => {
    if (!(await isAdmin(req.user.sub))) return reply.code(403).send({ error: 'not_admin' });
    return { connectors: (await db.select().from(connectors).orderBy(asc(connectors.sortOrder))).map(connectorView) };
  });
  app.put('/admin/connectors', async (req, reply) => {
    if (!(await isAdmin(req.user.sub))) return reply.code(403).send({ error: 'not_admin' });
    const b = Upsert.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid', issues: b.error.issues });
    const d = b.data;
    // MCP servers are tested on save; the tool list comes back for the allowlist.
    let tools: string[] | undefined;
    if (d.type === 'mcp') {
      if (!d.mcp_url) return reply.code(400).send({ error: 'mcp_url_required' });
      try {
        const [old] = await db.select().from(connectors).where(eq(connectors.slug, d.slug));
        tools = await deps.mcp.test(d.mcp_url, d.mcp_auth ?? (old?.mcpAuthEnc ? decrypt(old.mcpAuthEnc) : undefined));
      } catch (err) {
        return reply.code(400).send({ error: 'mcp_test_failed', message: `Couldn't connect: ${(err as Error).message}` });
      }
    }
    const values = {
      slug: d.slug, name: d.name, type: d.type, category: d.category, tagline: d.tagline, longDescription: d.long_description, capabilities: d.capabilities, scopes: d.scopes, senderDomains: d.sender_domains, featured: d.featured, sortOrder: d.sort_order, badge: d.badge, verified: d.verified, live: d.live,
      ...(d.mcp_url !== undefined && { mcpUrl: d.mcp_url }), ...(d.mcp_auth !== undefined && { mcpAuthEnc: d.mcp_auth ? encrypt(d.mcp_auth) : null }), ...(d.tool_allowlist && { toolAllowlist: d.tool_allowlist }),
    };
    const [row] = await db.insert(connectors).values(values).onConflictDoUpdate({ target: connectors.slug, set: values }).returning();
    return { connector: connectorView(row!), tools };
  });
  app.post<{ Params: { slug: string } }>('/admin/connectors/:slug/test', async (req, reply) => {
    if (!(await isAdmin(req.user.sub))) return reply.code(403).send({ error: 'not_admin' });
    const [c] = await db.select().from(connectors).where(eq(connectors.slug, req.params.slug));
    if (!c?.mcpUrl) return reply.code(400).send({ error: 'not_an_mcp_connector' });
    try {
      return { ok: true, tools: await deps.mcp.test(c.mcpUrl, c.mcpAuthEnc ? decrypt(c.mcpAuthEnc) : undefined) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  app.post<{ Params: { slug: string } }>('/admin/connectors/:slug/icon', async (req, reply) => {
    if (!(await isAdmin(req.user.sub))) return reply.code(403).send({ error: 'not_admin' });
    const file = await req.file({ limits: { fileSize: 512 * 1024 } });
    const ext = file && ({ 'image/png': 'png', 'image/svg+xml': 'svg' } as Record<string, string>)[file.mimetype];
    if (!file || !ext) return reply.code(400).send({ error: 'png_or_svg_only' });
    const buf = await file.toBuffer();
    if (file.file.truncated) return reply.code(400).send({ error: 'max_512_kb' });
    const name = `connector-${req.params.slug}-${randomBytes(4).toString('hex')}.${ext}`;
    await writeFile(join(config.UPLOAD_DIR, name), buf);
    const [row] = await db.update(connectors).set({ iconUrl: `/api/media/${name}` }).where(eq(connectors.slug, req.params.slug)).returning();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { connector: row };
  });
}
