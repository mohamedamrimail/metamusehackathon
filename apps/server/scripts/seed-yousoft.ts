import { eq } from 'drizzle-orm';
import { appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/db/client.ts';
import { connectors, partnerApplications, partnerMembers, partners, users } from '../src/db/schema.ts';
import { createCredentials, PARTNER_SCOPES } from '../src/partners/core.ts';

// P8: Yousoft IT as the first approved, verified partner, with Mohamed as owner. Its credentials go
// into .env (YOUSOFT_CLIENT_ID / _SECRET) for the recruiter portal, which uses the public API only.
// Idempotent. Usage: pnpm --filter @ipersons/server seed:yousoft

const ENV = fileURLToPath(new URL('../../../.env', import.meta.url));
const OWNERS = ['mohamed.amri.mail@gmail.com', 'amri@yousoft-it.com'];
const { db, pool } = createDb();

const [c] = await db.select().from(connectors).where(eq(connectors.slug, 'yousoft'));
if (!c) throw new Error('connector yousoft missing (run migrations)');
const manifest = { name: c.name, tagline: c.tagline, long_description: c.longDescription, category: c.category, capabilities: c.capabilities, user_scopes: ['receive_offers', 'public_profile', 'requests'], offer_types: ['job'] };
let [p] = await db.select().from(partners).where(eq(partners.slug, 'yousoft'));
if (!p) [p] = await db.insert(partners).values({ slug: 'yousoft', name: 'Yousoft IT', website: 'https://www.yousoft-it.com', scopes: [...PARTNER_SCOPES], verified: true, connectorId: c.id, manifest }).returning();
await db.update(connectors).set({ verified: true, live: true }).where(eq(connectors.id, c.id));

const [app] = await db.select().from(partnerApplications).where(eq(partnerApplications.partnerId, p!.id));
if (!app) {
  await db.insert(partnerApplications).values({
    company: 'Yousoft IT', website: 'https://www.yousoft-it.com', country: 'DE', contactName: 'Mohamed Amri', email: 'amri@yousoft-it.com',
    category: 'jobs', intendedUse: 'Hiring developers and interns: post jobs, talk to matched twins, request interviews.', requestedScopes: [...PARTNER_SCOPES],
    status: 'approved', reviewNote: 'Seeded as the first partner', partnerId: p!.id,
  });
}
for (const email of OWNERS) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (u) await db.insert(partnerMembers).values({ partnerId: p!.id, userId: u.id, role: 'owner' }).onConflictDoNothing();
}
const env = await readFile(ENV, 'utf8');
if (!/^YOUSOFT_CLIENT_ID=.+/m.test(env)) {
  const creds = await createCredentials(db, p!.id, 'recruiter portal');
  await appendFile(ENV, `\n# Yousoft IT partner credentials (recruiter portal at /org/yousoft uses the Partner API with these)\nYOUSOFT_CLIENT_ID=${creds.client_id}\nYOUSOFT_CLIENT_SECRET=${creds.client_secret}\n`);
  console.log('credentials written to .env');
}
console.log('Yousoft IT partner ready:', p!.id);
await pool.end();
