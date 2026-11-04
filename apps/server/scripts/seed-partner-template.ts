import { and, eq } from 'drizzle-orm';
import { createDb } from '../src/db/client.ts';
import { connectors, partnerApplications, partnerMembers, partnerOffers, partners, users } from '../src/db/schema.ts';
import { PARTNER_SCOPES } from '../src/partners/core.ts';

// A non-recruiting partner template: a local café with a deal and an event, so the Store shows more than
// jobs. It's clearly labelled as a sample. It uses the no-code console (/console/<slug>), no developers.
// Usage: pnpm --filter @ipersons/server seed:partner-template [member-email] [--remove]

const SLUG = 'cafe-jasmin';
const NAME = 'Café Jasmin (sample partner)';
const { db, pool } = createDb();

if (process.argv.includes('--remove')) {
  await db.delete(partners).where(eq(partners.slug, SLUG));
  await db.delete(connectors).where(eq(connectors.slug, SLUG));
  console.log('sample partner removed');
  await pool.end();
  process.exit(0);
}

const scopes = [
  { id: 'receive_offers', label: 'Receive deals and events', required: true, description: `${NAME} may propose deals and events to me` },
  { id: 'public_profile', label: 'Talk to my twin', required: false, description: `${NAME}'s assistant may talk to my twin about my public facts` },
  { id: 'requests', label: 'Ask me for things', required: false, description: `${NAME} may ask me for a reservation time (I always approve)` },
];
const store = {
  name: NAME, type: 'org' as const, category: 'other' as const, badge: 'sample',
  tagline: 'Coffee deals and tasting evenings near you', longDescription: 'A sample partner that shows how a local business uses i-persons without developers: it posts deals and events in the partner console, your twin tells you when one fits, and any reservation request waits for your yes.',
  capabilities: ['Proposes deals and events that fit you', 'Asks for a reservation only with your OK'], scopes, verified: false, live: true, sortOrder: 60,
};
let [c] = await db.select().from(connectors).where(eq(connectors.slug, SLUG));
[c] = c ? await db.update(connectors).set(store).where(eq(connectors.id, c.id)).returning() : await db.insert(connectors).values({ slug: SLUG, ...store }).returning();

const manifest = { name: NAME, tagline: store.tagline, long_description: store.longDescription, category: 'other', capabilities: store.capabilities, user_scopes: ['receive_offers', 'public_profile', 'requests'], offer_types: ['deal', 'event'] };
let [p] = await db.select().from(partners).where(eq(partners.slug, SLUG));
p ??= (await db.insert(partners).values({ slug: SLUG, name: NAME, website: 'https://example.com', scopes: PARTNER_SCOPES.filter((s) => s !== 'webhooks:manage'), connectorId: c!.id, manifest }).returning())[0]!;
const [application] = await db.select().from(partnerApplications).where(eq(partnerApplications.partnerId, p.id));
if (!application) {
  await db.insert(partnerApplications).values({
    company: NAME, website: 'https://example.com', country: 'TN', contactName: 'Sample owner', email: 'owner@example.com', category: 'other',
    intendedUse: 'Post coffee deals and tasting evenings; ask matched people for a reservation time.', requestedScopes: p.scopes as string[],
    status: 'approved', reviewNote: 'Seeded sample partner (no-code console)', partnerId: p.id,
  });
}
const memberEmail = process.argv.slice(2).find((a) => a.includes('@'));
if (memberEmail) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, memberEmail));
  if (u) await db.insert(partnerMembers).values({ partnerId: p.id, userId: u.id, role: 'owner' }).onConflictDoNothing();
}
const offers = [
  { type: 'deal', title: 'Two flat whites for the price of one (sample)', description: 'Weekday mornings before 10. A sample deal from the partner template.', location: 'Sfax centre', countries: ['TN'] },
  { type: 'event', title: 'Coffee tasting evening (sample)', description: 'Taste three single-origin coffees with the roaster, Friday 19:00. A sample event.', location: 'Sfax centre', countries: ['TN'] },
];
for (const o of offers) {
  const [exists] = await db.select({ id: partnerOffers.id }).from(partnerOffers).where(and(eq(partnerOffers.partnerId, p.id), eq(partnerOffers.title, o.title)));
  if (!exists) await db.insert(partnerOffers).values({ partnerId: p.id, ...o, validUntil: new Date(Date.now() + 30 * 86_400_000) });
}
console.log(`${NAME} ready in the Store; console at /console/${SLUG}${memberEmail ? ` for ${memberEmail}` : ''}. Remove with --remove.`);
await pool.end();
