import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { inviteCodes, users } from '../db/schema.ts';
import { real } from '../lib/metrics.ts';
import { chainState, completeChain } from '../twins/chain.ts';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

// Growth §2: the "twin chain" challenge for each user, and pilot session pages (/s/<code>) with a live
// counter of sign-ups, verified users and twins for the session's cohort (aggregate numbers only).

export async function growthRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  app.get<{ Params: { code: string } }>('/session/:code', async (req, reply) => {
    const [c] = await db.select().from(inviteCodes).where(and(eq(inviteCodes.code, req.params.code.toUpperCase()), eq(inviteCodes.kind, 'session')));
    if (!c?.cohort) return reply.code(404).send({ error: 'not_found' });
    const one = async (q: ReturnType<typeof sql>) => Number(((await db.execute(q)).rows[0] as { n: string } | undefined)?.n ?? 0);
    const cohortUsers = real(c.cohort);
    return {
      code: c.code, cohort: c.cohort, note: c.note, invite_url: `${config.PUBLIC_URL}/?invite=${c.code}`,
      open: !c.expiresAt || c.expiresAt > new Date(),
      signups: await one(sql`select count(*) n from users where id in ${cohortUsers}`),
      verified: await one(sql`select count(*) n from users where verified_at is not null and id in ${cohortUsers}`),
      twins: await one(sql`select count(*) n from ipersons where avatar_url is not null and user_id in ${cohortUsers}`),
    };
  });

  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);
    scope.get('/me/chain', async (req) => {
      await completeChain(db, req.user.sub);
      return chainState(db, req.user.sub);
    });
    scope.post('/me/chain/start', async (req) => {
      await db.update(users).set({ chainStartedAt: new Date() }).where(and(eq(users.id, req.user.sub), sql`${users.chainStartedAt} is null`));
      return chainState(db, req.user.sub);
    });
    // Badge on My twin and the public counter of completions (aggregate).
    scope.get('/me/badges', async (req) => {
      const [u] = await db.select({ done: users.chainCompletedAt }).from(users).where(and(eq(users.id, req.user.sub), isNotNull(users.chainCompletedAt)));
      return { badges: u ? [{ id: 'twin_chain', label: 'Twin chain: planned with a friend through your i-persons', at: u.done }] : [] };
    });
  });
}
