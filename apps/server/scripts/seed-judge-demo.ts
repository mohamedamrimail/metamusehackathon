import { randomBytes } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { CONSENT_VERSION } from '@ipersons/shared';
import { usdToMicros } from '../src/billing/credits.ts';
import { createDb } from '../src/db/client.ts';
import {
  actions, avatarAssets, bookings, connectors, conversations, ipersonRules, ipersons, partnerMatches, partnerOffers, partners,
  profileFacts, purchases, sourcePrefs, users, userServices,
} from '../src/db/schema.ts';
import { createDeps } from '../src/index.ts';
import { ensureTwin } from '../src/partners/core.ts';
import { hashPassword } from '../src/lib/password.ts';
import { refreshInsights } from '../src/mail/sync.ts';

// The judges' demo account: a finished twin with sample data, ready to try. Idempotent; each run sets a
// new password (printed, never committed), refreshes the sample data and the pending approval card.
// Usage: pnpm --filter @ipersons/server seed:judge-demo [--reset-chat]
//   --reset-chat also clears the demo conversation (judges share this account).
// seed:local runs it with DEMO_EMAIL / DEMO_PASSWORD / DEMO_PHONE set: a fixed login and a fictional verified number.

const EMAIL = process.env.DEMO_EMAIL || 'judge-demo@i-persons.com';
const FIXED_PASSWORD = process.env.DEMO_PASSWORD || undefined;
/** A fictional number (+1 NXX 555-01XX): marks the account verified; nothing is ever sent to it. */
const PHONE = process.env.DEMO_PHONE || undefined;
const TZ = 'Europe/Berlin';
const { db, pool } = createDb();

const password = FIXED_PASSWORD ?? randomBytes(9).toString('base64url');
const base = {
  name: 'Alex', passwordHash: await hashPassword(password), accountKind: 'demo', locale: 'en', timezone: TZ, country: 'DE', currency: 'EUR',
  gender: 'man' as const, ageRange: '35-44' as const, consentVersion: CONSENT_VERSION, consentAt: new Date(), setupStep: 'warmup', onboardedAt: new Date(),
  aiCreditMicros: usdToMicros(20), signupCountry: 'DE',
  ...(PHONE ? { phoneE164: PHONE, phoneCountry: 'US', verifiedAt: new Date() } : {}),
};
let [user] = await db.select().from(users).where(eq(users.email, EMAIL));
[user] = user
  ? await db.update(users).set(base).where(eq(users.id, user.id)).returning()
  : await db.insert(users).values({ email: EMAIL, ...base }).returning();
const userId = user!.id;

// The twin: a neutral library avatar (with poses), a stock voice that fits, public at @demo.
const [asset] = await db.select().from(avatarAssets).where(and(eq(avatarAssets.library, true), eq(avatarAssets.variant, 'base'), eq(avatarAssets.gender, 'man'), eq(avatarAssets.ageRange, '35-44')));
const twin = {
  displayName: 'i-Alex', handle: 'demo', publicEnabled: true, openToJobs: true,
  publicBio: 'Product designer in Berlin who loves city trips and good coffee. (Demo twin with sample data.)',
  publicGreeting: 'Hi, I’m Alex’s i-person. Alex is a demo persona: ask me about his work, or leave him a message.',
  avatarUrl: asset?.imageUrl ?? null, avatarAssetId: asset?.id ?? null,
  avatarMeta: { mouth: (asset?.masks as { mouth?: unknown } | null)?.mouth },
};
let [ip] = await db.select().from(ipersons).where(eq(ipersons.userId, userId));
[ip] = ip
  ? await db.update(ipersons).set(twin).where(eq(ipersons.id, ip.id)).returning()
  : await db.insert(ipersons).values({ userId, ...twin }).returning();
const ipersonId = ip!.id;

if (process.argv.includes('--reset-chat')) await db.delete(conversations).where(eq(conversations.ipersonId, ipersonId));

// Facts: some public (visitors and partners may hear them), some private.
const facts = [
  { category: 'preference' as const, key: 'work', value: 'Product designer (UX, React prototypes) at a Berlin start-up', visibility: 'public' as const },
  { category: 'preference' as const, key: 'skills', value: 'Figma, React, TypeScript, user research', visibility: 'public' as const },
  { category: 'goal' as const, key: 'career', value: 'Open to a senior frontend or design-engineering role, remote or Berlin', visibility: 'public' as const },
  { category: 'routine' as const, key: 'sport', value: 'Plays table tennis on Sunday afternoons', visibility: 'private' as const },
  { category: 'preference' as const, key: 'travel_style', value: 'City trips, 4-star hotels near the station, free cancellation', visibility: 'private' as const },
  { category: 'constraint' as const, key: 'budget', value: 'Keeps hotel stays under €130 a night', visibility: 'private' as const },
];
for (const f of facts) {
  await db.insert(profileFacts).values({ ipersonId, ...f, source: 'user_edit' })
    .onConflictDoUpdate({ target: [profileFacts.ipersonId, profileFacts.category, profileFacts.key, profileFacts.status], set: { value: f.value, visibility: f.visibility } });
}

// Two rules and preferred sources.
await db.delete(ipersonRules).where(eq(ipersonRules.ipersonId, ipersonId));
await db.insert(ipersonRules).values([
  { ipersonId, kind: 'do', text: 'Always show prices in euros', source: 'onboarding' },
  { ipersonId, kind: 'dont', text: 'Never book anything on Sunday mornings', source: 'onboarding' },
]);
await db.delete(sourcePrefs).where(eq(sourcePrefs.ipersonId, ipersonId));
await db.insert(sourcePrefs).values([
  { ipersonId, category: 'travel', provider: 'booking', rank: 1 },
  { ipersonId, category: 'travel', provider: 'skyscanner', rank: 2 },
  { ipersonId, category: 'shopping', provider: 'amazon', rank: 1 },
]);

// Services in the Store, with sample orders and stays (marked SAMPLE-, and "(sample)" in the titles).
const conn = async (slug: string) => (await db.select().from(connectors).where(eq(connectors.slug, slug)))[0];
const amazon = await conn('amazon-de');
const booking = await conn('booking');
const skyscanner = await conn('skyscanner');
const yousoft = await conn('yousoft');
for (const [c, scopes] of [[amazon, ['read_orders', 'suggest']], [booking, ['read_bookings', 'suggest']], [skyscanner, ['read_bookings', 'suggest']], [yousoft, ['receive_offers', 'public_profile', 'requests']]] as const) {
  if (c) await db.insert(userServices).values({ userId, connectorId: c.id, grantedScopes: [...scopes], statusLine: 'Sample data for the demo' }).onConflictDoNothing();
}
await db.delete(purchases).where(and(eq(purchases.userId, userId), like(purchases.providerRef, 'SAMPLE-%')));
await db.delete(bookings).where(and(eq(bookings.userId, userId), like(bookings.providerRef, 'SAMPLE-%')));
const day = (n: number) => new Date(Date.now() + n * 86_400_000);
if (amazon) {
  for (const [i, ago] of [[1, 75], [2, 40], [3, 6]] as const) {
    await db.insert(purchases).values({ userId, connectorId: amazon.id, providerRef: `SAMPLE-302-${i}`, merchant: 'Amazon.de', title: 'Lavazza coffee capsules (sample)', itemRef: 'B07PGL2ZSL', category: 'coffee', quantity: 1, amountCents: 1899, currency: 'EUR', orderedAt: day(-ago) });
  }
  await db.insert(purchases).values({ userId, connectorId: amazon.id, providerRef: 'SAMPLE-302-9', merchant: 'Amazon.de', title: 'USB-C hub (sample)', category: 'electronics', amountCents: 3999, currency: 'EUR', orderedAt: day(-20), deliveryAt: day(1) });
}
if (booking) {
  for (const [i, ago] of [[1, 160], [2, 95], [3, 30]] as const) {
    await db.insert(bookings).values({ userId, connectorId: booking.id, providerRef: `SAMPLE-BK-${i}`, kind: 'hotel', title: 'Hotel near München Hauptbahnhof (sample)', city: 'Munich', country: 'Germany', stars: 4, nights: 2, startAt: day(-ago), endAt: day(-ago + 2), bookedAt: day(-ago - 21), freeCancellation: true, amountCents: 23800, currency: 'EUR' });
  }
}
const learned = await refreshInsights(createDeps(db), userId);

// One pending approval card: table tennis next Sunday at 17:00 (Berlin). Valid 72 h, so judges find it waiting.
await db.delete(actions).where(and(eq(actions.ipersonId, ipersonId), eq(actions.status, 'proposed')));
const sunday = new Date();
sunday.setUTCDate(sunday.getUTCDate() + ((7 - sunday.getUTCDay()) % 7 || 7));
const startLocal = `${sunday.toISOString().slice(0, 10)}T17:00:00`;
const endLocal = `${sunday.toISOString().slice(0, 10)}T18:30:00`;
await db.insert(actions).values({
  ipersonId, tool: 'calendar_book', risk: 'write', status: 'proposed',
  args: { title: 'Table tennis with Sam', start: startLocal, end: endLocal, location: 'TTC Berlin-Mitte' },
  summary: `Book "Table tennis with Sam" on Sunday ${startLocal.slice(0, 16).replace('T', ' ')} at TTC Berlin-Mitte`,
  confirmToken: randomBytes(18).toString('base64url'), expiresAt: new Date(Date.now() + 72 * 3_600_000),
});

// One Yousoft-IT offer matched to the demo twin (public facts only, as the matcher would).
let offerNote = 'no Yousoft partner found (run seed:yousoft first)';
const [yp] = await db.select().from(partners).where(eq(partners.slug, 'yousoft'));
if (yp) {
  let [offer] = await db.select().from(partnerOffers).where(and(eq(partnerOffers.partnerId, yp.id), eq(partnerOffers.title, 'Senior frontend engineer, React (sample offer)')));
  offer ??= (await db.insert(partnerOffers).values({
    partnerId: yp.id, type: 'job', title: 'Senior frontend engineer, React (sample offer)', remote: true, countries: ['DE', 'TN'],
    description: 'Build AI-powered web products with React and TypeScript. Sample offer for the demo account.',
    requirements: { skills: ['React', 'TypeScript', 'UX'] }, location: 'Remote / Berlin', link: 'https://www.yousoft-it.com',
  }).returning())[0]!;
  await ensureTwin(db, yp.id, userId);
  await db.insert(partnerMatches).values({ offerId: offer.id, userId, score: 86, reason: 'React and TypeScript skills, open to senior frontend roles, remote' })
    .onConflictDoUpdate({ target: [partnerMatches.offerId, partnerMatches.userId], set: { status: 'new', score: 86 } });
  offerNote = `matched to "${offer.title}"`;
}

console.log(`Demo account: ${EMAIL}`);
console.log(`Password:     ${password}${FIXED_PASSWORD ? '' : '   (new on every run)'}`);
console.log(`Twin:         i-Alex, public at /@demo, ${asset ? 'library avatar' : 'NO AVATAR (run gen:neutral-avatars or seed:local)'}`);
console.log(`Sample data:  ${learned.length} insights, 1 pending card (Sunday ${startLocal.slice(0, 10)} 17:00), Yousoft offer ${offerNote}`);
await pool.end();
