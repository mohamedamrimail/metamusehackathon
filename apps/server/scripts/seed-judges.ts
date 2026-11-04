import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { createDb } from '../src/db/client.ts';
import { inviteCodes } from '../src/db/schema.ts';

// The hackathon judges' invite code: multi-use, no expiry (change it in the admin panel), works from any
// country and marks the accounts as judges (excluded from metrics, may skip WhatsApp). Idempotent: an
// existing judges' code is reused and printed. Usage: pnpm --filter @ipersons/server seed:invite [--new]

const { db, pool } = createDb();
const fresh = process.argv.includes('--new');
let [code] = fresh ? [] : await db.select().from(inviteCodes).where(eq(inviteCodes.kind, 'judge'));
if (code) {
  [code] = await db.update(inviteCodes).set({ expiresAt: null, maxUses: Math.max(code.maxUses, 1000) }).where(eq(inviteCodes.code, code.code)).returning();
} else {
  const value = `JUDGES-${randomBytes(4).toString('hex').toUpperCase()}`;
  [code] = await db.insert(inviteCodes).values({ code: value, kind: 'judge', note: 'Hackathon judges', maxUses: 1000, expiresAt: null }).returning();
}
console.log(`Judges' code: ${code!.code}  (${code!.uses}/${code!.maxUses} used, no expiry)`);
console.log(`Invite link:  ${config.PUBLIC_URL}/?invite=${code!.code}`);
await pool.end();
