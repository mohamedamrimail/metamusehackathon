import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { invites, inviteCodes, planParticipants, planSessions, twinConnections, users } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { growthMetrics } from '../src/lib/metrics.ts';
import { timeGivenBack } from '../src/lib/impact.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { chainState, completeChain } from '../src/twins/chain.ts';
import { acceptInvite, recordWhatsappInvite } from '../src/twins/invites.ts';
import { geoFor, reset, testDb, testGeo } from './helpers.ts';
import { addContact, person } from './twins-helpers.ts';

// Growth §2: cohorts, viral coefficient, the twin chain challenge and pilot session counters.

const { db, pool } = testDb();
let app: FastifyInstance;
beforeEach(async () => {
  await reset(db);
  await db.execute(sql`truncate invite_codes, invites, twin_connections, plan_sessions cascade`);
  geoFor.country = 'TN';
  await app?.close();
  app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true }));
});
afterAll(async () => { await app.close(); await pool.end(); });

const register = (email: string, invite_code?: string) =>
  app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name: 'X', ...(invite_code ? { invite_code } : {}) } });

describe('cohorts and growth', () => {
  it('labels users by the code they used (even in allowed countries) and invitees by their inviter', async () => {
    await db.insert(inviteCodes).values({ code: 'CAMPUS-1', kind: 'session', cohort: 'campus-pilot', maxUses: 100 });
    expect((await register('student@example.com', 'CAMPUS-1')).statusCode).toBe(200);
    const [s] = await db.select().from(users).where(eq(users.email, 'student@example.com'));
    expect(s).toMatchObject({ cohort: 'campus-pilot', referral: false });

    // A personal invite from that student: the friend joins the same cohort, marked as a referral.
    const friendContact = await addContact(db, s!.id, { name: 'Friend', phones: ['+21655000111'] });
    await recordWhatsappInvite(db, s!, friendContact);
    const [inv] = await db.select().from(invites);
    const friend = await person(db, { name: 'Friend', phone: '+21655000111' });
    await acceptInvite(db, inv!.token, friend.user.id);
    const [f] = await db.select().from(users).where(eq(users.id, friend.user.id));
    expect(f).toMatchObject({ cohort: 'campus-pilot', referral: true });

    const g = await growthMetrics(db, { cohort: 'campus-pilot' });
    expect(g).toMatchObject({ inviting_users: 1, invites_sent: 1, invite_to_signup_pct: 100, signup_to_verified_pct: 100, k: 1 });

    const session = (await app.inject({ url: '/api/session/campus-1' })).json();
    expect(session).toMatchObject({ cohort: 'campus-pilot', signups: 2, verified: 1 });
    expect(JSON.stringify(session)).not.toContain('example.com');
  });

  it('completes the twin chain once, crediting both people, and counts the plan as time given back', async () => {
    const a = await person(db, { name: 'Hana', phone: '+21655000201' });
    const b = await person(db, { name: 'Sara', phone: '+21655000202' });
    expect((await chainState(db, a.user.id)).steps).toEqual({ connect: false, plan: false, booked: false });
    await db.insert(twinConnections).values({ requesterId: a.user.id, recipientId: b.user.id, status: 'active' });
    const [plan] = await db.insert(planSessions).values({ creatorId: a.user.id, type: 'coffee', durationMin: 60, dateFrom: '2026-11-03', dateTo: '2026-11-07', status: 'booked', expiresAt: new Date(Date.now() + 86_400_000) }).returning();
    await db.insert(planParticipants).values({ sessionId: plan!.id, userId: b.user.id, status: 'accepted' });

    expect(await completeChain(db, a.user.id)).toBe(true);
    expect(await completeChain(db, a.user.id)).toBe(false); // once
    const [ha, sa] = await Promise.all([a, b].map(async (p) => (await db.select().from(users).where(eq(users.id, p.user.id)))[0]!));
    expect(ha!.chainCompletedAt).not.toBeNull();
    expect(sa!.chainCompletedAt).not.toBeNull();
    expect(ha!.aiCreditMicros).toBe(5_000_000 + 1_000_000);
    expect(sa!.aiCreditMicros).toBe(5_000_000 + 1_000_000);

    expect((await timeGivenBack(db, { userId: a.user.id })).byKind.twin_plan?.count).toBe(1);
    expect((await timeGivenBack(db, { userId: b.user.id })).byKind.twin_plan?.count).toBe(1);
  });
});
