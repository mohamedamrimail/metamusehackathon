import { and, desc, eq, gt, gte, sql } from 'drizzle-orm';
import { config } from '../config.ts';
import { runtimeSettings } from '../lib/settings.ts';
import type { Db } from '../db/client.ts';
import { aiUsage, familyGroups, familyMembers, users } from '../db/schema.ts';
import type { Llm, LlmUsage } from '../meta/llm.ts';

// AI credit: users start with AI_FREE_CREDIT_USD. Each Meta model call is charged at Meta's list price
// (PRICE_* in .env) plus AI_PLATFORM_FEE_RATIO × that as our fee. Amounts are micro-USD integers.

export type Metered =
  | { kind: 'llm'; model: string; usage: LlmUsage }
  | { kind: 'stt'; model: string; seconds: number }
  | { kind: 'image'; model: string; images: number }
  | { kind: 'sam'; model: string; images: number };

const MICROS = 1_000_000;
export const usdToMicros = (usd: number) => Math.round(usd * MICROS);
export const microsToUsd = (micros: number) => micros / MICROS;

/** What Meta charges for this call, in micro-USD. */
export function metaCostMicros(m: Metered): number {
  switch (m.kind) {
    case 'llm': {
      const cached = Math.min(m.usage.cachedInput, m.usage.input);
      return usdToMicros(
        ((m.usage.input - cached) * config.PRICE_LLM_INPUT_PER_M
          + cached * config.PRICE_LLM_CACHED_INPUT_PER_M
          + m.usage.output * config.PRICE_LLM_OUTPUT_PER_M) / 1_000_000,
      );
    }
    // Meta meters audio in whole seconds.
    case 'stt': return usdToMicros(Math.ceil(m.seconds) * config.PRICE_STT_PER_HOUR / 3600);
    case 'image': return usdToMicros(m.images * config.PRICE_IMAGE);
    case 'sam': return usdToMicros(m.images * config.PRICE_SAM_IMAGE);
  }
}

export class NoCreditError extends Error {
  constructor() {
    super('AI credit used up');
  }
}

/** Records the call and takes Meta's cost plus the platform fee: from the family pool first (Impact §4), then the user's credit. */
export async function charge(db: Db, userId: string, m: Metered, scope: 'owner' | 'visitor' = 'owner'): Promise<number> {
  const meta = metaCostMicros(m);
  if (meta <= 0) return 0;
  const fee = Math.round(meta * (await runtimeSettings(db)).feeRatio);
  const { kind, model, ...units } = m;
  await db.transaction(async (tx) => {
    await tx.insert(aiUsage).values({ userId, kind, model, units, metaCostMicros: meta, feeMicros: fee, scope });
    let own = meta + fee;
    const [member] = await tx.select({ groupId: familyMembers.groupId }).from(familyMembers).where(eq(familyMembers.userId, userId));
    if (member) {
      const [g] = await tx.select({ pool: familyGroups.poolMicros }).from(familyGroups).where(eq(familyGroups.id, member.groupId)).for('update');
      const fromPool = Math.min(Math.max(g?.pool ?? 0, 0), own);
      if (fromPool > 0) {
        await tx.update(familyGroups).set({ poolMicros: sql`${familyGroups.poolMicros} - ${fromPool}` }).where(eq(familyGroups.id, member.groupId));
        own -= fromPool;
      }
    }
    if (own > 0) await tx.update(users).set({ aiCreditMicros: sql`${users.aiCreditMicros} - ${own}` }).where(eq(users.id, userId));
  });
  return meta + fee;
}

/** True while the user (or their family pool) has credit left. Calls are charged after they run, so the last one may overdraw a little. */
export async function hasCredit(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), gt(users.aiCreditMicros, 0)));
  if (row) return true;
  const [pool] = await db.select({ id: familyGroups.id }).from(familyMembers).innerJoin(familyGroups, eq(familyGroups.id, familyMembers.groupId))
    .where(and(eq(familyMembers.userId, userId), gt(familyGroups.poolMicros, 0)));
  return Boolean(pool);
}

export async function assertCredit(db: Db, userId: string): Promise<void> {
  if (!(await hasCredit(db, userId))) throw new NoCreditError();
}

/** The same model, charging each call that reports usage to `userId`. */
export function meteredLlm(llm: Llm, db: Db, userId: string, model: string, scope: 'owner' | 'visitor' = 'owner'): Llm {
  const search = llm.search?.bind(llm);
  return {
    async complete(req) {
      const res = await llm.complete(req);
      if (res.usage) await charge(db, userId, { kind: 'llm', model, usage: res.usage }, scope);
      return res;
    },
    // HACKATHON: billed on tokens only; Meta's pricing page lists no per-search fee (checked Oct 30).
    ...(search && {
      async search(req) {
        const res = await search(req);
        if (res.usage) await charge(db, userId, { kind: 'llm', model, usage: res.usage }, scope);
        return res;
      },
    }),
  };
}

export async function creditSummary(db: Db, userId: string) {
  const [user] = await db.select({ credit: users.aiCreditMicros }).from(users).where(eq(users.id, userId));
  const byKind = await db.select({
    kind: aiUsage.kind,
    calls: sql<number>`count(*)::int`,
    meta: sql<number>`coalesce(sum(${aiUsage.metaCostMicros}), 0)::bigint`,
    fee: sql<number>`coalesce(sum(${aiUsage.feeMicros}), 0)::bigint`,
  }).from(aiUsage).where(eq(aiUsage.userId, userId)).groupBy(aiUsage.kind);
  const recent = await db.select().from(aiUsage).where(eq(aiUsage.userId, userId)).orderBy(desc(aiUsage.createdAt)).limit(20);
  const usd = (n: number | string) => microsToUsd(Number(n));
  return {
    balance_usd: usd(user?.credit ?? 0),
    free_usd: config.AI_FREE_CREDIT_USD,
    fee_ratio: config.AI_PLATFORM_FEE_RATIO,
    by_kind: byKind.map((k) => ({ kind: k.kind, calls: k.calls, meta_usd: usd(k.meta), fee_usd: usd(k.fee) })),
    recent: recent.map((r) => ({ kind: r.kind, model: r.model, units: r.units, meta_usd: usd(r.metaCostMicros), fee_usd: usd(r.feeMicros), at: r.createdAt })),
  };
}

/** What visitors to the user's public twin cost today (Meta + fee), for the daily visitor budget. */
export async function visitorSpentToday(db: Db, userId: string): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const [r] = await db.select({ n: sql<number>`coalesce(sum(${aiUsage.metaCostMicros} + ${aiUsage.feeMicros}), 0)::bigint` }).from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.scope, 'visitor'), gte(aiUsage.createdAt, since)));
  return Number(r?.n ?? 0);
}
