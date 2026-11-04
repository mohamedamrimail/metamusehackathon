import { and, eq, like } from 'drizzle-orm';
import { createDb } from '../src/db/client.ts';
import { bookings, connectors, ipersons, profileFacts, purchases, users, userServices } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { refreshInsights } from '../src/mail/sync.ts';

// Phase 8.4: the demo account. Idempotent. Sample rows are marked: provider refs start with "SAMPLE-".
// Usage: pnpm --filter @ipersons/server seed:demo [owner-email] [--with-request]
//   --with-request also has Yousoft chat with the twin and ask for an interview (sends WhatsApp buttons).

const email = process.argv.slice(2).find((a) => a.includes('@')) ?? 'mohamed.amri.mail@gmail.com';
const withRequest = process.argv.includes('--with-request');
const { db, pool } = createDb();
const [user] = await db.select().from(users).where(eq(users.email, email));
if (!user) throw new Error(`no user ${email}`);
const [ip] = await db.select().from(ipersons).where(eq(ipersons.userId, user.id));
if (!ip) throw new Error('create the i-person first (onboarding)');

// Public link @mohamed with a few public facts.
const [taken] = await db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.handle, 'mohamed'));
await db.update(ipersons).set({
  handle: !taken || taken.id === ip.id ? 'mohamed' : ip.handle, publicEnabled: Boolean(user.phoneE164), openToJobs: true,
  publicBio: 'Founder of Yousoft IT in Sfax. Building i-persons for the Meta AI hackathon.',
}).where(eq(ipersons.id, ip.id));
for (const f of [
  { category: 'preference' as const, key: 'work', value: 'Founder of Yousoft IT, a software company in Sfax, Tunisia' },
  { category: 'preference' as const, key: 'stack', value: 'Builds AI products with React, TypeScript and Meta Muse models' },
  { category: 'routine' as const, key: 'sport', value: 'Plays table tennis on Sundays' },
  { category: 'goal' as const, key: 'meetings', value: 'Happy to meet founders and engineers for a coffee in Sfax or online' },
]) {
  await db.insert(profileFacts).values({ ipersonId: ip.id, ...f, source: 'user_edit', visibility: 'public' })
    .onConflictDoUpdate({ target: [profileFacts.ipersonId, profileFacts.category, profileFacts.key, profileFacts.status], set: { value: f.value, visibility: 'public' } });
}

// Services: Amazon.de, Booking.com, Yousoft (with talk + requests).
const conn = async (slug: string) => (await db.select().from(connectors).where(eq(connectors.slug, slug)))[0]!;
const amazon = await conn('amazon-de');
const booking = await conn('booking');
const yousoft = await conn('yousoft');
for (const [c, scopes] of [[amazon, ['read_orders', 'suggest']], [booking, ['read_bookings', 'suggest']], [yousoft, ['receive_offers', 'public_profile', 'requests']]] as const) {
  await db.insert(userServices).values({ userId: user.id, connectorId: c.id, grantedScopes: [...scopes], statusLine: 'Sample data for the demo' }).onConflictDoNothing();
}

// Sample orders and stays (clearly marked), as if imported from confirmation emails.
await db.delete(purchases).where(and(eq(purchases.userId, user.id), like(purchases.providerRef, 'SAMPLE-%')));
await db.delete(bookings).where(and(eq(bookings.userId, user.id), like(bookings.providerRef, 'SAMPLE-%')));
const day = (n: number) => new Date(Date.now() + n * 86_400_000);
for (const [i, ago] of [[1, 75], [2, 40], [3, 6]] as const) {
  await db.insert(purchases).values({ userId: user.id, connectorId: amazon.id, providerRef: `SAMPLE-302-${i}`, merchant: 'Amazon.de', title: 'Lavazza coffee capsules (sample)', itemRef: 'B07PGL2ZSL', category: 'coffee', quantity: 1, amountCents: 1899, currency: 'EUR', orderedAt: day(-ago) });
}
await db.insert(purchases).values({ userId: user.id, connectorId: amazon.id, providerRef: 'SAMPLE-302-9', merchant: 'Amazon.de', title: 'USB-C hub (sample)', category: 'electronics', amountCents: 3999, currency: 'EUR', orderedAt: day(-20), deliveryAt: day(1) });
for (const [i, ago] of [[1, 160], [2, 95], [3, 30]] as const) {
  await db.insert(bookings).values({ userId: user.id, connectorId: booking.id, providerRef: `SAMPLE-BK-${i}`, kind: 'hotel', title: 'Hotel near München Hauptbahnhof (sample)', city: 'Munich', country: 'Germany', stars: 4, nights: 2, startAt: day(-ago), endAt: day(-ago + 2), bookedAt: day(-ago - 21), freeCancellation: true, amountCents: 23800, currency: 'EUR' });
}
await db.insert(bookings).values({ userId: user.id, connectorId: booking.id, providerRef: 'SAMPLE-BK-4', kind: 'hotel', title: 'Hotel near München Hauptbahnhof (sample)', city: 'Munich', country: 'Germany', stars: 4, nights: 2, startAt: day(10), endAt: day(12), bookedAt: day(-11), freeCancellation: true });

const deps = createDeps(db);
const learned = await refreshInsights(deps, user.id);
console.log(`@mohamed ${user.phoneE164 ? 'is public' : 'saved (verify WhatsApp to make it public)'}; ${learned.length} insights learned from sample data`);

// An open Yousoft job, posted through the Partner API like the portal does.
const app = buildApp(deps);
const creds = { client_id: process.env.YOUSOFT_CLIENT_ID, client_secret: process.env.YOUSOFT_CLIENT_SECRET };
const { config } = await import('../src/config.ts');
const tok = await app.inject({ method: 'POST', url: '/api/partner/v1/oauth/token', payload: { grant_type: 'client_credentials', client_id: config.YOUSOFT_CLIENT_ID ?? creds.client_id, client_secret: config.YOUSOFT_CLIENT_SECRET ?? creds.client_secret } });
const auth = { authorization: `Bearer ${tok.json().access_token}` };
const offers = (await app.inject({ url: '/api/partner/v1/offers', headers: auth })).json().offers as { id: string; title: string; status: string }[];
let job = offers.find((o) => o.title === 'AI product engineer (demo)' && o.status === 'open');
if (!job) job = (await app.inject({ method: 'POST', url: '/api/partner/v1/offers', headers: auth, payload: { type: 'job', title: 'AI product engineer (demo)', description: 'Build AI twins with React, TypeScript and Meta Muse models. Sfax or remote.', requirements: { skills: ['React', 'TypeScript', 'AI'] }, location: 'Sfax', remote: true } })).json().offer;
console.log('Yousoft job open:', job!.id);

if (withRequest) {
  await new Promise((r) => setTimeout(r, 8000)); // matching
  const matches = (await app.inject({ url: `/api/partner/v1/offers/${job!.id}/matches`, headers: auth })).json().matches as { twin_id: string }[];
  if (!matches.length) console.log('no match yet (needs public facts, Open to job offers, Yousoft activated)');
  else {
    const conv = (await app.inject({ method: 'POST', url: `/api/partner/v1/twins/${matches[0]!.twin_id}/conversations`, headers: auth, payload: { offer_id: job!.id } })).json().conversation;
    await app.inject({ method: 'POST', url: `/api/partner/v1/conversations/${conv.id}/messages`, headers: auth, payload: { text: 'Hi! What does he build, and would he be open to a short call?' } });
    const slot = day(2); slot.setUTCHours(9, 0, 0, 0);
    await app.inject({ method: 'POST', url: `/api/partner/v1/twins/${matches[0]!.twin_id}/requests`, headers: auth, payload: { kind: 'schedule', offer_id: job!.id, slots: [slot.toISOString()] } });
    console.log('recruiter conversation + interview request waiting for approval');
  }
}
await app.close();
await pool.end();
process.exit(0);
