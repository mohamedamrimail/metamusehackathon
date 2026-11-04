import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { wallets } from '../db/schema.ts';

export class WalletError extends Error {}

type Wallet = typeof wallets.$inferSelect;

const monthOf = (d: Date) => d.toISOString().slice(0, 7);

/** Why `cents` can't be spent now, or null if it can. */
export function walletRefusal(w: Wallet, cents: number, currency: string, now: Date): string | null {
  const spent = w.spentMonth === monthOf(now) ? w.spentThisMonthCents : 0;
  const fmt = (c: number) => `${(c / 100).toFixed(2)} ${w.currency}`;
  if (currency.toUpperCase() !== w.currency.toUpperCase()) return `wallet is in ${w.currency}, not ${currency}`;
  if (cents > w.perActionLimitCents) return `${fmt(cents)} is over the per-action limit of ${fmt(w.perActionLimitCents)}`;
  if (spent + cents > w.monthlyBudgetCents) return `${fmt(cents)} would exceed the monthly budget (${fmt(w.monthlyBudgetCents - spent)} left)`;
  if (cents > w.balanceCents) return `balance ${fmt(w.balanceCents)} is too low`;
  return null;
}

export async function getWallet(db: Db, ipersonId: string): Promise<Wallet | undefined> {
  const [w] = await db.select().from(wallets).where(eq(wallets.ipersonId, ipersonId));
  return w;
}

/** Debits the wallet atomically, re-checking limits under a row lock. */
export async function charge(db: Db, ipersonId: string, cents: number, currency: string, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const [w] = await tx.select().from(wallets).where(eq(wallets.ipersonId, ipersonId)).for('update');
    if (!w) throw new WalletError('no wallet set up');
    const refusal = walletRefusal(w, cents, currency, now);
    if (refusal) throw new WalletError(refusal);
    const month = monthOf(now);
    const spent = w.spentMonth === month ? w.spentThisMonthCents : 0;
    await tx.update(wallets).set({
      balanceCents: w.balanceCents - cents,
      spentThisMonthCents: spent + cents,
      spentMonth: month,
    }).where(eq(wallets.id, w.id));
  });
}

export async function refund(db: Db, ipersonId: string, cents: number): Promise<void> {
  await db.update(wallets).set({
    balanceCents: sql`${wallets.balanceCents} + ${cents}`,
    spentThisMonthCents: sql`greatest(${wallets.spentThisMonthCents} - ${cents}, 0)`,
  }).where(eq(wallets.ipersonId, ipersonId));
}
