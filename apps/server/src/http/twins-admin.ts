import { count, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { adminLog, invites, planSessions, twinConnections, users } from '../db/schema.ts';
import { connectPausedUntil } from '../twins/connections.ts';
import { saveTwinSettings, twinSettings } from '../twins/settings.ts';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

// Admin → Twins: invite/referral metrics and the contacts & twin-to-twin settings.

const admins = () => config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Extra admin metrics sections, filled in by the connection and planning parts. */
export const twinMetricsExtras: ((deps: AppDeps) => Promise<Record<string, unknown>>)[] = [];

export async function twinsAdminRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const who = new WeakMap<FastifyRequest, string>();
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    await requireUser(req, reply);
    if (reply.sent) return;
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.user.sub));
    if (!u || !admins().includes(u.email)) return reply.code(403).send({ error: 'not_admin' });
    who.set(req, u.email);
  });

  app.get('/admin/twins', async () => {
    const byChannel = await db.select({ channel: invites.channel, n: count(), reminded: sql<number>`count(${invites.remindedAt})::int` }).from(invites).groupBy(invites.channel);
    const [signedUp] = await db.select({ n: count() }).from(invites).where(isNotNull(invites.acceptedUserId));
    const [verified] = await db.select({ n: count() }).from(invites).innerJoin(users, eq(users.id, invites.acceptedUserId)).where(isNotNull(users.phoneE164));
    const [paid] = await db.select({ n: sql<number>`coalesce(sum(${invites.rewardMicros}), 0)::bigint`, invites: sql<number>`count(*) filter (where ${invites.rewardMicros} > 0)::int` }).from(invites);
    const sent = byChannel.reduce((s, c) => s + c.n, 0);
    const extras = Object.assign({}, ...(await Promise.all(twinMetricsExtras.map((f) => f(deps)))));
    const conns = await db.select({ status: twinConnections.status, n: count() }).from(twinConnections).groupBy(twinConnections.status);
    // Flagged: users whose connection requests are paused (3 declines from different people in a week).
    const requesters = await db.selectDistinct({ id: twinConnections.requesterId, name: users.name, email: users.email }).from(twinConnections)
      .innerJoin(users, eq(users.id, twinConnections.requesterId)).where(eq(twinConnections.status, 'declined'));
    const paused = [];
    for (const r of requesters) {
      const until = await connectPausedUntil(db, r.id);
      if (until) paused.push({ name: r.name, email: r.email, until: until.toISOString() });
    }
    const plans = await db.select({ status: planSessions.status, n: count() }).from(planSessions).groupBy(planSessions.status);
    return {
      settings: await twinSettings(db),
      plans: { by_status: Object.fromEntries(plans.map((p) => [p.status, p.n])) },
      invites: {
        by_channel: Object.fromEntries(byChannel.map((c) => [c.channel, { sent: c.n, reminded: c.reminded }])),
        sent, signed_up: signedUp?.n ?? 0, verified: verified?.n ?? 0,
        // Paid to both sides: the inviter and the invitee.
        referral_credit_usd: (Number(paid?.n ?? 0) * 2) / 1_000_000, rewarded_invites: paid?.invites ?? 0,
      },
      connections: { by_status: Object.fromEntries(conns.map((c) => [c.status, c.n])), paused_users: paused },
      ...extras,
    };
  });

  app.put('/admin/twins/settings', async (req, reply) => {
    const body = z.object({
      referralCreditUsd: z.number().min(0).max(20).optional(),
      referralMaxRewarded: z.number().int().min(0).max(1000).optional(),
      invitesBypassCountry: z.boolean().optional(),
      invitesPerDay: z.number().int().min(0).max(100).optional(),
      connectRequestsPerDay: z.number().int().min(0).max(200).optional(),
      waTemplatesApproved: z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const value = await saveTwinSettings(db, body.data, who.get(req)!);
    await db.insert(adminLog).values({ admin: who.get(req)!, action: 'twins.settings', detail: body.data });
    return { settings: value };
  });
}
