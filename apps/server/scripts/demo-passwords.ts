import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb } from '../src/db/client.ts';
import { users } from '../src/db/schema.ts';
import { hashPassword } from '../src/lib/password.ts';
import { PERSONAS } from './video-demo-data.ts';

// New passwords for the video demo accounts (Adam, Hana, Sara, Giga), for jury members who want to try them.
// Prints them once; nothing is stored in the repo. Run seed:video-demo first. Rerun to change them.
// Usage: pnpm --filter @ipersons/server demo:passwords [adam hana …]

const { db, pool } = createDb();
const pick = process.argv.slice(2).filter((a) => a in PERSONAS) as (keyof typeof PERSONAS)[];
const emails = (pick.length ? pick : Object.keys(PERSONAS) as (keyof typeof PERSONAS)[]).map((id) => PERSONAS[id].email);
const rows = await db.select({ id: users.id, email: users.email }).from(users).where(and(inArray(users.email, emails), eq(users.accountKind, 'demo')));
for (const r of rows) {
  const password = randomBytes(9).toString('base64url');
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, r.id));
  console.log(`${r.email}  password: ${password}`);
}
const missing = emails.filter((e) => !rows.some((r) => r.email === e));
if (missing.length) console.log(`not found (run seed:video-demo first): ${missing.join(', ')}`);
await pool.end();
