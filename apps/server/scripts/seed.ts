// Seeds the demo user "Merry" (SPEC demo story). Re-running replaces her data.
import { eq } from 'drizzle-orm';
import { upsertFact } from '../src/agent/memory.ts';
import { insertEvent } from '../src/agent/tools/calendar.ts';
import { createDb } from '../src/db/client.ts';
import { ipersons, users, wallets } from '../src/db/schema.ts';
import { parseLocal } from '../src/lib/time.ts';

const EMAIL = 'merry@i-persons.com';
const TZ = 'Africa/Tunis';
const { db, pool } = createDb();

await db.delete(users).where(eq(users.email, EMAIL));
const [user] = await db.insert(users).values({ email: EMAIL, name: 'Merry', locale: 'en', timezone: TZ }).returning();
const [ip] = await db.insert(ipersons).values({ userId: user!.id, displayName: "Merry's i-person", personaStyle: 'warm, brief' }).returning();
await db.insert(wallets).values({
  ipersonId: ip!.id, balanceCents: 30_000, currency: 'TND', perActionLimitCents: 10_000, monthlyBudgetCents: 50_000,
});

const facts = [
  ['routine', 'yoga', 'Wants yoga twice a week, evenings after 18:00; keeps missing classes'],
  ['routine', 'work_hours', 'Works 9:00–17:30 on weekdays'],
  ['goal', 'this_month', 'Get back to regular yoga; organise Sam’s surprise party'],
  ['contact', 'sam', 'Sam — close friend, birthday surprise party planned'],
  ['preference', 'travel_style', 'Beach and sun, short flights from Tunis, budget-conscious'],
  ['constraint', 'never_do', 'Never accept calls or meetings on Sunday'],
  ['constraint', 'max_order', 'Ask before any order above 50 TND'],
] as const;
for (const [category, key, value] of facts) {
  await upsertFact(db, ip!.id, { category, key, value, source: 'onboarding', confidence: 0.95 });
}

// A busy-ish week starting from today, so the agent has something to plan around.
const day = (offset: number, hhmm: string) => {
  const d = new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: TZ });
  return parseLocal(`${d}T${hhmm}`, TZ);
};
const events: [number, string, string, string][] = [
  [0, '10:00', '11:00', 'Team standup'],
  [1, '18:30', '20:00', 'Dinner with parents'],
  [2, '14:00', '15:30', 'Client review'],
  [4, '19:00', '21:00', 'Cinema'],
];
for (const [off, s, e, title] of events) {
  await insertEvent(db, ip!.id, { title, startsAt: day(off, s), endsAt: day(off, e) });
}

console.log(`seeded Merry: user ${user!.id}, i-person ${ip!.id}`);
await pool.end();
