import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { usdToMicros } from '../billing/credits.ts';
import type { Db } from '../db/client.ts';
import { invites, planParticipants, planSessions, twinConnections, users } from '../db/schema.ts';
import { twinSettings } from './settings.ts';

// Growth §2 "twin chain" challenge: plan a coffee with a friend through your i-persons, in 3 steps:
// 1. invite or connect a friend, 2. plan something, 3. both confirm (the plan is booked).
// On completion both people get the referral credit (Admin → Twins) and a badge, once.

export interface ChainState { started: boolean; steps: { connect: boolean; plan: boolean; booked: boolean }; completed: boolean; credit_usd: number }

export async function chainState(db: Db, userId: string): Promise<ChainState> {
  const [u] = await db.select({ started: users.chainStartedAt, done: users.chainCompletedAt }).from(users).where(eq(users.id, userId));
  const [inv] = await db.select({ id: invites.id }).from(invites).where(eq(invites.inviterId, userId)).limit(1);
  const [con] = await db.select({ id: twinConnections.id }).from(twinConnections)
    .where(and(eq(twinConnections.status, 'active'), or(eq(twinConnections.requesterId, userId), eq(twinConnections.recipientId, userId)))).limit(1);
  const mine = or(eq(planSessions.creatorId, userId), sql`${planSessions.id} in (select session_id from plan_participants where user_id = ${userId})`);
  const [plan] = await db.select({ id: planSessions.id }).from(planSessions).where(mine).limit(1);
  const [booked] = await db.select({ id: planSessions.id }).from(planSessions).where(and(mine, eq(planSessions.status, 'booked'))).limit(1);
  return {
    started: Boolean(u?.started), completed: Boolean(u?.done), credit_usd: (await twinSettings(db)).referralCreditUsd,
    steps: { connect: Boolean(inv || con), plan: Boolean(plan), booked: Boolean(booked) },
  };
}

/** Marks completion once all steps are done; both people of the booked plan get the credit once. */
export async function completeChain(db: Db, userId: string): Promise<boolean> {
  const s = await chainState(db, userId);
  if (s.completed || !s.steps.connect || !s.steps.plan || !s.steps.booked) return false;
  const [booked] = await db.select({ id: planSessions.id, creator: planSessions.creatorId }).from(planSessions)
    .where(and(eq(planSessions.status, 'booked'), or(eq(planSessions.creatorId, userId), sql`${planSessions.id} in (select session_id from plan_participants where user_id = ${userId})`))).limit(1);
  const people = new Set([userId]);
  if (booked) {
    people.add(booked.creator);
    for (const p of await db.select({ id: planParticipants.userId }).from(planParticipants).where(and(eq(planParticipants.sessionId, booked.id), eq(planParticipants.status, 'accepted')))) people.add(p.id);
  }
  const micros = usdToMicros(s.credit_usd);
  for (const id of people) {
    // Atomic and once per person: only the first completion pays.
    const [won] = await db.update(users).set({ chainCompletedAt: new Date(), chainStartedAt: sql`coalesce(${users.chainStartedAt}, now())`, aiCreditMicros: sql`${users.aiCreditMicros} + ${micros}` })
      .where(and(eq(users.id, id), isNull(users.chainCompletedAt))).returning({ id: users.id });
    void won;
  }
  return true;
}
