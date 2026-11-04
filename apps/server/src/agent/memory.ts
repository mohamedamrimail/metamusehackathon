import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import type { PendingMemoryItem } from '@ipersons/shared';
import { ipersonRules, profileFacts } from '../db/schema.ts';

export type FactCategory = (typeof profileFacts.$inferSelect)['category'];
export type FactSource = (typeof profileFacts.$inferSelect)['source'];
export const FACT_CATEGORIES = ['preference', 'routine', 'goal', 'constraint', 'contact'] as const;

/** Facts for the prompt: highest confidence first, then newest. */
export function listFacts(db: Db, ipersonId: string, opts: { category?: FactCategory; limit?: number } = {}) {
  return db.select().from(profileFacts)
    .where(and(
      eq(profileFacts.ipersonId, ipersonId),
      eq(profileFacts.status, 'active'),
      opts.category ? eq(profileFacts.category, opts.category) : undefined,
    ))
    .orderBy(desc(profileFacts.confidence), desc(profileFacts.updatedAt))
    .limit(opts.limit ?? 60);
}

/**
 * Saves a fact. With `pendingFrom` (an outside source read before it was learned) it is stored as
 * pending next to any active fact with the same key, which stays untouched until the user keeps it.
 * Visibility is never set here: a fact only becomes public through the user's own action.
 */
export async function upsertFact(db: Db, ipersonId: string, fact: {
  category: FactCategory; key: string; value: string; source?: FactSource; confidence?: number; pendingFrom?: string;
}) {
  const { pendingFrom, ...f } = fact;
  const key = f.key.trim().toLowerCase().replace(/\s+/g, '_');
  const status = pendingFrom ? 'pending' : 'active';
  const [row] = await db.insert(profileFacts)
    .values({ ipersonId, ...f, key, status, sourceHint: pendingFrom ?? null })
    .onConflictDoUpdate({
      target: [profileFacts.ipersonId, profileFacts.category, profileFacts.key, profileFacts.status],
      set: {
        value: f.value,
        source: f.source ?? 'conversation',
        confidence: f.confidence ?? 0.8,
        sourceHint: pendingFrom ?? null,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row!;
}

/** Keep: the pending fact replaces the active one with the same key. */
export async function keepFact(db: Db, ipersonId: string, id: string) {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(profileFacts).where(and(eq(profileFacts.id, id), eq(profileFacts.ipersonId, ipersonId), eq(profileFacts.status, 'pending')));
    if (!p) return undefined;
    await tx.delete(profileFacts).where(and(eq(profileFacts.ipersonId, ipersonId), eq(profileFacts.category, p.category), eq(profileFacts.key, p.key), eq(profileFacts.status, 'active')));
    const [row] = await tx.update(profileFacts).set({ status: 'active', updatedAt: sql`now()` }).where(eq(profileFacts.id, id)).returning();
    return row;
  });
}

/** Facts and rules waiting for the user's Keep / Discard, oldest first. */
export async function listPendingMemory(db: Db, ipersonId: string): Promise<PendingMemoryItem[]> {
  const facts = await db.select().from(profileFacts).where(and(eq(profileFacts.ipersonId, ipersonId), eq(profileFacts.status, 'pending'))).orderBy(profileFacts.createdAt);
  const rules = await db.select().from(ipersonRules).where(and(eq(ipersonRules.ipersonId, ipersonId), eq(ipersonRules.status, 'pending'))).orderBy(ipersonRules.createdAt);
  return [
    ...facts.map((f) => ({ kind: 'fact' as const, id: f.id, text: f.value, source: f.sourceHint ?? 'outside content' })),
    ...rules.map((r) => ({ kind: 'rule' as const, id: r.id, text: `${r.kind === 'do' ? 'Always' : 'Never'}: ${r.text}`, source: r.sourceHint ?? 'outside content' })),
  ];
}

/** Keep activates a held fact or rule; Discard deletes it. False if it was already handled. */
export async function decideMemory(db: Db, ipersonId: string, kind: 'fact' | 'rule', id: string, keep: boolean): Promise<boolean> {
  if (kind === 'fact') {
    if (keep) return Boolean(await keepFact(db, ipersonId, id));
    return (await db.delete(profileFacts).where(and(eq(profileFacts.id, id), eq(profileFacts.ipersonId, ipersonId), eq(profileFacts.status, 'pending'))).returning()).length > 0;
  }
  const match = and(eq(ipersonRules.id, id), eq(ipersonRules.ipersonId, ipersonId), eq(ipersonRules.status, 'pending'));
  return keep
    ? (await db.update(ipersonRules).set({ status: 'active' }).where(match).returning()).length > 0
    : (await db.delete(ipersonRules).where(match).returning()).length > 0;
}
