import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { partnerMembers, partners, users } from '../db/schema.ts';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

// No-code partner console (/console/<slug>): a partner without developers posts offers through a form,
// sees anonymous matches and follows its requests. Every call goes through the public Partner API with
// the partner's own token and scopes, exactly like code would — no private shortcut into the database.

/** The Partner API calls the console may make on a member's behalf. */
const ALLOWED: [string, RegExp][] = [
  ['GET', /^\/offers$/], ['POST', /^\/offers$/], ['PATCH', /^\/offers\/[0-9a-f-]{36}$/],
  ['GET', /^\/offers\/[0-9a-f-]{36}\/matches$/],
  ['POST', /^\/twins\/tw_[a-z2-7]{20}\/conversations$/], ['POST', /^\/conversations\/[0-9a-f-]{36}\/messages$/],
  ['POST', /^\/twins\/tw_[a-z2-7]{20}\/requests$/], ['GET', /^\/requests$/], ['GET', /^\/requests\/[0-9a-f-]{36}$/],
];
export const consoleAllows = (method: string, path: string) => ALLOWED.some(([m, re]) => m === method && re.test(path));

export async function consoleRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  app.addHook('preHandler', requireUser);

  const isAdmin = async (userId: string) => {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    return Boolean(u && config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).includes(u.email));
  };
  /** The partner a member (or an admin) may act for. */
  const partnerFor = async (userId: string, slug: string) => {
    const [p] = await db.select().from(partners).where(eq(partners.slug, slug));
    if (!p || p.status !== 'active') return undefined;
    const [m] = await db.select().from(partnerMembers).where(and(eq(partnerMembers.partnerId, p.id), eq(partnerMembers.userId, userId)));
    return m || (await isAdmin(userId)) ? p : undefined;
  };

  app.get('/console', async (req) => {
    const mine = await db.select({ id: partnerMembers.partnerId }).from(partnerMembers).where(eq(partnerMembers.userId, req.user.sub));
    const rows = mine.length ? await db.select().from(partners).where(inArray(partners.id, mine.map((m) => m.id))) : [];
    return { partners: rows.map((p) => ({ slug: p.slug, name: p.name, status: p.status, verified: p.verified, scopes: p.scopes, operator_affiliated: p.operatorAffiliated })) };
  });

  app.post<{ Params: { slug: string } }>('/console/:slug/api', async (req, reply) => {
    const body = z.object({ method: z.enum(['GET', 'POST', 'PATCH']), path: z.string().max(200), body: z.unknown().optional() }).safeParse(req.body);
    if (!body.success || !consoleAllows(body.data.method, body.data.path)) return reply.code(400).send({ error: 'not_allowed' });
    const p = await partnerFor(req.user.sub, req.params.slug);
    if (!p) return reply.code(403).send({ error: 'not_a_member' });
    // The same short-lived token POST /partner/v1/oauth/token would issue, with the partner's own scopes.
    const token = app.jwt.sign({ pid: p.id, scopes: p.scopes, typ: 'partner' } as never, { expiresIn: '5m' });
    const r = await app.inject({
      method: body.data.method, url: `/api/partner/v1${body.data.path}`, headers: { authorization: `Bearer ${token}` },
      ...(body.data.body !== undefined ? { payload: body.data.body as object } : {}),
    });
    return reply.code(r.statusCode).send(r.json());
  });
}
