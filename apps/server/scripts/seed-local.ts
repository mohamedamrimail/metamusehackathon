import { and, eq } from 'drizzle-orm';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.ts';
import { createDb } from '../src/db/client.ts';
import { avatarAssets, calendarEvents, ipersons, profileFacts, users } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { hashPassword } from '../src/lib/password.ts';
import { PERSONAS, seedVideoDemo } from './video-demo-data.ts';

// First-start seed for a local copy (docker compose runs it on every start; it is idempotent):
//  1. the starter avatar set (apps/server/starter-avatars) → UPLOAD_DIR + avatar_assets library rows;
//  2. the demo user with a finished twin, sample data and one approval card waiting (seed-judge-demo.ts);
//  3. a few events in the demo calendar, so "Am I free tomorrow?" has an answer.
//  4. the demo family Adam, Hana, Sara and Giga (seed:video-demo), same password; DEMO_FAMILY=off skips it.
// Usage: pnpm --filter @ipersons/server seed:local [--force] [--avatars]

export const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@i-persons.test';
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'ipersons-demo';

const STARTER = fileURLToPath(new URL('../starter-avatars', import.meta.url));
const { db, pool } = createDb();

// 1. Starter avatars: copy the files once, insert the rows that are missing.
interface StarterRow { id: string; lookId: string; style: string; variant: string; gender: string; ageRange: string; imageUrl: string; masks: Record<string, unknown> }
const manifest = JSON.parse(await readFile(join(STARTER, 'manifest.json'), 'utf8')) as StarterRow[];
await mkdir(config.UPLOAD_DIR, { recursive: true });
const file = (url: string) => url.replace(/^\/api\/media\//, '');
let copied = 0;
for (const r of manifest) {
  for (const url of [r.imageUrl, r.masks.cutout_url as string | undefined]) {
    if (!url) continue;
    const dest = join(config.UPLOAD_DIR, file(url));
    if (await stat(dest).catch(() => null)) continue;
    await copyFile(join(STARTER, file(url)), dest);
    copied++;
  }
}
const inserted = await db.insert(avatarAssets).values(manifest.map((r) => ({
  id: r.id, lookId: r.lookId, library: true, style: r.style, variant: r.variant,
  gender: r.gender as 'woman' | 'man' | 'unspecified', ageRange: r.ageRange as '18-24', imageUrl: r.imageUrl, masks: r.masks,
}))).onConflictDoNothing().returning({ id: avatarAssets.id });
console.log(`Starter avatars: ${manifest.length} poses (${inserted.length} new rows, ${copied} files copied)`);

// 2. The demo user: created once (a twin with facts = done); later starts only print the login.
const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL));
const [twin] = existing ? await db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.userId, existing.id)) : [];
const done = twin && (await db.select({ id: profileFacts.id }).from(profileFacts).where(eq(profileFacts.ipersonId, twin.id)).limit(1)).length > 0;
if (!done || process.argv.includes('--force')) {
  process.env.DEMO_EMAIL = DEMO_EMAIL;
  process.env.DEMO_PASSWORD = DEMO_PASSWORD;
  process.env.DEMO_PHONE ||= '+12025550199';
  await import('./seed-judge-demo.ts');
} else {
  console.log(`Demo account: ${DEMO_EMAIL} (exists; run seed:local --force to reset its sample data)`);
}

// 3. Demo calendar: three events in the next days (only when the calendar is empty).
const [u] = await db.select({ id: users.id, tz: users.timezone }).from(users).where(eq(users.email, DEMO_EMAIL));
const [ip] = u ? await db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.userId, u.id)) : [];
if (ip && !(await db.select({ id: calendarEvents.id }).from(calendarEvents).where(and(eq(calendarEvents.ipersonId, ip.id), eq(calendarEvents.source, 'local'))).limit(1)).length) {
  const at = (days: number, hourUtc: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(hourUtc, 0, 0, 0); return d; };
  await db.insert(calendarEvents).values([
    { ipersonId: ip.id, title: 'Design review with the product team', startsAt: at(1, 8), endsAt: at(1, 9), location: 'Office, room 2' },
    { ipersonId: ip.id, title: 'Dentist', startsAt: at(2, 14), endsAt: at(2, 15), location: 'Torstraße 12' },
    { ipersonId: ip.id, title: 'Dinner with Lea', startsAt: at(3, 18), endsAt: at(3, 20), location: 'Mitte' },
  ]);
  console.log('Demo calendar: 3 sample events added');
}

// 4. The demo family for the jury scenarios (Adam, Hana, Sara, Giga; twin-to-twin, plans): once, unless DEMO_FAMILY=off.
// Same local password as the demo user. Their emails are @i-persons.com, but demo accounts never send email or WhatsApp.
if (process.env.DEMO_FAMILY !== 'off') {
  const [adam] = await db.select({ id: users.id }).from(users).where(eq(users.email, PERSONAS.adam.email));
  if (!adam || process.argv.includes('--force')) {
    const deps = createDeps(db);
    const app = buildApp(deps);
    await app.ready();
    await seedVideoDemo(app, deps, { avatars: process.argv.includes('--avatars') });
    await app.close();
  }
  const hash = await hashPassword(DEMO_PASSWORD);
  for (const p of Object.values(PERSONAS)) await db.update(users).set({ passwordHash: hash }).where(and(eq(users.email, p.email), eq(users.accountKind, 'demo')));
  console.log(`Demo family: ${Object.values(PERSONAS).map((p) => p.email).join(', ')} (password ${DEMO_PASSWORD})`);
}

console.log(`\nLog in at ${config.APP_URL} with ${DEMO_EMAIL} / ${DEMO_PASSWORD}\n`);
await pool.end().catch(() => {});
