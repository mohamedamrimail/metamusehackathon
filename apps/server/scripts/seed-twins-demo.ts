import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { CONSENT_VERSION } from '@ipersons/shared';
import { upsertFact } from '../src/agent/memory.ts';
import { usdToMicros } from '../src/billing/credits.ts';
import { config } from '../src/config.ts';
import { createDb } from '../src/db/client.ts';
import {
  actions, avatarAssets, calendarEvents, contacts, ipersonRules, ipersons, planOptions, planParticipants, planSessions, twinConnections, users,
} from '../src/db/schema.ts';
import { createDeps } from '../src/index.ts';
import { hashPassword } from '../src/lib/password.ts';
import { parseLocal } from '../src/lib/time.ts';
import { refreshIdentifiers } from '../src/twins/identifiers.ts';
import { matchContacts } from '../src/twins/matching.ts';
import { sendOptions, startPlan } from '../src/twins/plans.ts';
import { notifyOutside } from '../src/twins/notify.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';

// Demo for "my twin talks to your twin" (docs/twin-to-twin.md): two connected demo accounts, Hana and
// Sara, with calendars and shared preferences, one finished coffee plan in their history, and one plan
// request waiting for Sara's answer. Idempotent; prints new passwords on each run (never committed).
// Usage: pnpm --filter @ipersons/server seed:twins-demo [--yes]
//   Refuses to run on a database whose name doesn't end in _test unless --yes is given.

const dbName = new URL(config.DATABASE_URL).pathname.slice(1);
if (!/_test$/.test(dbName) && !process.argv.includes('--yes')) {
  console.error(`Refusing to seed "${dbName}" without --yes.`);
  process.exit(1);
}

const TZ = 'Africa/Tunis';
const { db, pool } = createDb();
// Nothing leaves the server while seeding: no WhatsApp, no email, no paid model calls (places: partner venues only).
notifyOutside.muted = true;
const deps = createDeps(db, { wa: undefined, llm: new DemoLlm(), billing: false, demoMode: true });

const PEOPLE = [
  { email: 'hana.demo@i-persons.com', name: 'Hana', twin: 'i-Hana', gender: 'woman' as const, age: '25-34' as const, phone: '+21650000101' },
  { email: 'sara.demo@i-persons.com', name: 'Sara', twin: 'i-Sara', gender: 'woman' as const, age: '35-44' as const, phone: '+21650000102' },
];

const ids: { userId: string; ipersonId: string }[] = [];
for (const p of PEOPLE) {
  const password = randomBytes(9).toString('base64url');
  const base = {
    name: p.name, passwordHash: await hashPassword(password), accountKind: 'demo', locale: 'en', timezone: TZ, country: 'TN', currency: 'TND',
    gender: p.gender, ageRange: p.age, consentVersion: CONSENT_VERSION, consentAt: new Date(), setupStep: 'warmup', onboardedAt: new Date(),
    aiCreditMicros: usdToMicros(10), signupCountry: 'TN', phoneE164: p.phone, phoneCountry: 'TN', verifiedAt: new Date(), emailVerifiedAt: new Date(),
  };
  let [u] = await db.select().from(users).where(eq(users.email, p.email));
  [u] = u ? await db.update(users).set(base).where(eq(users.id, u.id)).returning() : await db.insert(users).values({ email: p.email, ...base }).returning();
  const [asset] = await db.select().from(avatarAssets).where(and(eq(avatarAssets.library, true), eq(avatarAssets.variant, 'base'), eq(avatarAssets.gender, p.gender), eq(avatarAssets.ageRange, p.age)));
  const twin = { displayName: p.twin, avatarUrl: asset?.imageUrl ?? null, avatarAssetId: asset?.id ?? null };
  let [ip] = await db.select().from(ipersons).where(eq(ipersons.userId, u!.id));
  [ip] = ip ? await db.update(ipersons).set(twin).where(eq(ipersons.id, ip.id)).returning() : await db.insert(ipersons).values({ userId: u!.id, ...twin }).returning();
  ids.push({ userId: u!.id, ipersonId: ip!.id });
  await refreshIdentifiers(db, u!.id);
  console.log(`${p.email}  password: ${password}`);
}
const [hana, sara] = ids as [typeof ids[0], typeof ids[0]];

// Start clean for the demo data (only these two accounts).
const userIds = [hana.userId, sara.userId];
await db.delete(planSessions).where(inArray(planSessions.creatorId, userIds));
await db.delete(twinConnections).where(inArray(twinConnections.requesterId, userIds));
await db.delete(twinConnections).where(inArray(twinConnections.recipientId, userIds));
await db.delete(actions).where(inArray(actions.ipersonId, [hana.ipersonId, sara.ipersonId]));
await db.delete(calendarEvents).where(inArray(calendarEvents.ipersonId, [hana.ipersonId, sara.ipersonId]));
await db.delete(ipersonRules).where(inArray(ipersonRules.ipersonId, [hana.ipersonId, sara.ipersonId]));
await db.delete(contacts).where(inArray(contacts.userId, userIds));

// Each in the other's address book, plus a few people who aren't on i-persons yet.
const book = async (owner: string, rows: { name: string; phones?: string[]; emails?: string[]; relationship: string; notes?: string }[]) => {
  for (const r of rows) {
    await db.insert(contacts).values({ userId: owner, key: r.emails?.[0] ?? `name:${r.name.toLowerCase()}`, name: r.name, emails: r.emails ?? [], phones: r.phones ?? [], relationship: r.relationship, notes: r.notes ?? null, inAddressBook: true });
  }
};
await book(hana.userId, [
  { name: 'Sara Ben Ali', phones: ['+216 50 000 102'], relationship: 'friend', notes: 'Old friend from university, loves padel' },
  { name: 'Amel (sister)', phones: ['+216 50 000 777'], relationship: 'family' },
  { name: 'Karim', emails: ['karim@example.com'], relationship: 'colleague' },
]);
await book(sara.userId, [
  { name: 'Hana Amri', phones: ['+216 50 000 101'], relationship: 'friend' },
  { name: 'Youssef', emails: ['youssef@example.com'], relationship: 'family' },
]);
await matchContacts(db, hana.userId);
await matchContacts(db, sara.userId);

// Shared preferences (only the ticked facts are shared) and simple rules.
const fact = (ip: string, key: string, value: string) => upsertFact(db, ip, { category: 'preference', key, value, source: 'user_edit' });
const hanaFacts = [await fact(hana.ipersonId, 'coffee', 'Flat white; quiet cafés with wifi'), await fact(hana.ipersonId, 'sport', 'Padel on weekends')];
const saraFacts = [await fact(sara.ipersonId, 'coffee', 'Espresso; terraces in Sfax centre'), await fact(sara.ipersonId, 'sport', 'Padel and swimming'), await fact(sara.ipersonId, 'food', 'Vegetarian')];
await db.insert(ipersonRules).values([
  { ipersonId: sara.ipersonId, kind: 'dont', text: 'No meetings before 9', source: 'user' },
  { ipersonId: sara.ipersonId, kind: 'dont', text: 'No dinners on Sunday', source: 'user' },
]);
const scopes = ['plan', 'availability', 'preferences', 'suggest'];
const [conn] = await db.insert(twinConnections).values({
  requesterId: hana.userId, recipientId: sara.userId, status: 'active', requesterScopes: scopes, recipientScopes: scopes,
  requesterFactIds: hanaFacts.map((f) => f.id), recipientFactIds: saraFacts.map((f) => f.id), respondedAt: new Date(),
}).returning();

// Calendars: a few busy blocks next week.
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const nextMon = (8 - new Date().getUTCDay()) % 7 || 7;
const ev = (ip: string, title: string, d: number, from: string, to: string) =>
  db.insert(calendarEvents).values({ ipersonId: ip, title, startsAt: parseLocal(`${day(d)}T${from}`, TZ), endsAt: parseLocal(`${day(d)}T${to}`, TZ) });
await ev(hana.ipersonId, 'Team stand-up', nextMon, '09:00', '10:00');
await ev(hana.ipersonId, 'Dentist', nextMon + 1, '08:00', '11:00');
await ev(sara.ipersonId, 'Client workshop', nextMon, '10:00', '13:00');
await ev(sara.ipersonId, 'Swimming', nextMon + 2, '07:00', '09:00');

// History: a coffee last week, booked in both calendars.
const past = parseLocal(`${day(-6)}T16:00`, TZ);
const [done] = await db.insert(planSessions).values({
  creatorId: hana.userId, type: 'coffee', durationMin: 60, dateFrom: day(-8), dateTo: day(-5), timeOfDay: 'afternoon', area: 'Sfax centre',
  status: 'booked', bookedStart: past, bookedEnd: new Date(past.getTime() + 3_600_000), expiresAt: new Date(Date.now() - 4 * 86_400_000),
  createdAt: new Date(Date.now() - 9 * 86_400_000),
}).returning();
const [place] = await db.insert(planOptions).values({ sessionId: done!.id, kind: 'place', value: { name: 'Café Le Diwan', address: 'Avenue Hedi Chaker, Sfax' }, source: 'web', position: 3 }).returning();
const [slot] = await db.insert(planOptions).values({ sessionId: done!.id, kind: 'slot', value: { start: past.toISOString(), end: new Date(past.getTime() + 3_600_000).toISOString() }, source: 'calendar', position: 0 }).returning();
await db.update(planSessions).set({ bookedPlaceId: place!.id }).where(eq(planSessions.id, done!.id));
await db.insert(planParticipants).values({ sessionId: done!.id, userId: sara.userId, status: 'accepted', chosenSlotIds: [slot!.id], chosenPlaceId: place!.id, respondedAt: past });
await ev(hana.ipersonId, 'Coffee with Sara Ben Ali', -6, '16:00', '17:00');
await ev(sara.ipersonId, 'Coffee with Hana Amri', -6, '16:00', '17:00');

// Waiting: Hana asked for dinner next week; Sara's card is open. Real protocol (no web search in a
// seed: places are partner venues only, or none).
const [hanasContact] = await db.select().from(contacts).where(and(eq(contacts.userId, hana.userId), eq(contacts.matchedUserId, sara.userId)));
const started = await startPlan(deps, hana.userId, {
  contacts: [hanasContact!.id], type: 'dinner', duration_minutes: 90, date_from: day(nextMon), date_to: day(nextMon + 4), time_of_day: 'evening',
  area: 'Sfax centre', note: 'Somewhere with vegetarian options for you!', auto_confirm: false,
});
await sendOptions(deps, hana.userId, started.session_id);
await db.update(actions).set({ status: 'done', decidedAt: new Date() }).where(and(eq(actions.ipersonId, hana.ipersonId), eq(actions.status, 'proposed')));
console.log(`Connected (${conn!.id}); history: 1 booked coffee; waiting for Sara: dinner plan ${started.session_id}.`);
await pool.end();
process.exit(0);
