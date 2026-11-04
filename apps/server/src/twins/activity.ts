import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { actions, ipersons } from '../db/schema.ts';

// Steps the user approved by tapping a button (Send invite, Connect twins, Accept…) are written to
// `actions` as already-done rows, so they show in Activity like everything else the twin did.

export async function ipersonOf(db: Db, userId: string): Promise<string | undefined> {
  const [ip] = await db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.userId, userId));
  return ip?.id;
}

export async function logDone(db: Db, userId: string, a: { tool: string; args: Record<string, unknown>; summary: string; result?: unknown; status?: 'done' | 'failed' }) {
  const ipersonId = await ipersonOf(db, userId);
  if (!ipersonId) return undefined;
  const now = new Date();
  const [row] = await db.insert(actions).values({
    ipersonId, tool: a.tool, args: a.args, risk: 'write', status: a.status ?? 'done', summary: a.summary.slice(0, 300),
    result: a.result ?? { ok: true }, confirmToken: randomBytes(18).toString('base64url'), expiresAt: now, decidedAt: now,
  }).returning();
  return row;
}
