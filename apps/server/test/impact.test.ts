import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { actions, ipersons, timeEstimates, users } from '../src/db/schema.ts';
import { formatMinutes, timeGivenBack } from '../src/lib/impact.ts';
import { makeIperson, reset, testDb } from './helpers.ts';

// Impact §1: time given back counts only completed, approved actions; judges/admins are excluded;
// an edited estimate applies going forward.

const { db, pool } = testDb();
beforeEach(async () => {
  await reset(db);
  await db.delete(timeEstimates).where(eq(timeEstimates.updatedBy, 'test'));
});
afterAll(() => pool.end());

let n = 0;
const act = (ipersonId: string, tool: string, status: 'done' | 'proposed' | 'rejected' | 'expired', args: object, at: Date) =>
  db.insert(actions).values({ ipersonId, tool, args, risk: 'write', status, summary: tool, confirmToken: `t-${++n}`, expiresAt: at, decidedAt: status === 'proposed' ? null : at });

describe('time given back', () => {
  it('counts completed, approved actions only, per email and per hand-off type', async () => {
    const { user, iperson } = await makeIperson(db);
    const now = new Date();
    await act(iperson.id, 'calendar_book', 'done', {}, now);                                        // 2
    await act(iperson.id, 'send_email', 'done', { to: ['a@x.de', 'b@x.de', 'c@x.de'] }, now);       // 3 × 3
    await act(iperson.id, 'prepare_checkout', 'done', { provider: 'booking' }, now);               // 10
    await act(iperson.id, 'prepare_checkout', 'done', { provider: 'amazon' }, now);                // 3
    await act(iperson.id, 'calendar_book', 'proposed', {}, now);
    await act(iperson.id, 'calendar_book', 'rejected', {}, now);
    await act(iperson.id, 'send_email', 'expired', { to: ['z@x.de'] }, now);
    const r = await timeGivenBack(db, { userId: user.id });
    expect(r.minutes).toBe(2 + 9 + 10 + 3);
    expect(r.byKind).toMatchObject({ calendar: { count: 1, minutes: 2 }, email: { count: 3, minutes: 9 }, travel_handoff: { count: 1 }, reorder_handoff: { count: 1 } });
    expect(formatMinutes(80)).toBe('1 h 20 min');
  });

  it('leaves judges and admins out of the totals', async () => {
    const real = await makeIperson(db, { email: 'real@example.com' });
    const judge = await makeIperson(db, { email: 'judge@example.com' });
    const admin = await makeIperson(db, { email: 'admin@example.com' });
    await db.update(users).set({ accountKind: 'judge' }).where(eq(users.id, judge.user.id));
    for (const p of [real, judge, admin]) await act(p.iperson.id, 'calendar_book', 'done', {}, new Date());
    expect((await timeGivenBack(db)).minutes).toBe(2);
    void ipersons;
  });

  it('applies an edited estimate going forward only', async () => {
    const { user, iperson } = await makeIperson(db);
    await act(iperson.id, 'calendar_book', 'done', {}, new Date(Date.now() - 60_000));
    await db.insert(timeEstimates).values({ kind: 'calendar', minutes: 5, justification: 'test', updatedBy: 'test' });
    await act(iperson.id, 'calendar_book', 'done', {}, new Date(Date.now() + 1000));
    expect((await timeGivenBack(db, { userId: user.id })).minutes).toBe(2 + 5);
  });
});
