import { and, eq } from 'drizzle-orm';
import type { ToolContext } from '../agent/tools/types.ts';
import type { Db } from '../db/client.ts';
import { contacts, ipersons, users } from '../db/schema.ts';
import type { AppDeps } from '../http/deps.ts';

// Shared bits for the twin-to-twin agent tools: the app's deps (set at startup, like the other handlers)
// and finding the contact the user named.

export const twinDeps: { deps?: AppDeps } = {};

export async function ownerOf(ctx: ToolContext) {
  const [row] = await ctx.db.select({ user: users }).from(ipersons).innerJoin(users, eq(users.id, ipersons.userId)).where(eq(ipersons.id, ctx.ipersonId));
  return row?.user;
}

/** The user's contact best matching a name ("Sami", "my sister" → label/relationship), or undefined. */
export async function findContact(db: Db, userId: string, name: string) {
  const rows = await db.select().from(contacts).where(eq(contacts.userId, userId));
  const n = name.trim().toLowerCase().replace(/^my\s+/, '');
  return rows.find((c) => c.name.toLowerCase() === n)
    ?? rows.find((c) => c.name.toLowerCase().split(/\s+/).includes(n))
    ?? rows.find((c) => (c.label ?? '').toLowerCase() === n)
    ?? rows.find((c) => c.name.toLowerCase().includes(n));
}

export const contactById = async (db: Db, userId: string, id: string) =>
  (await db.select().from(contacts).where(and(eq(contacts.id, id), eq(contacts.userId, userId))))[0];
