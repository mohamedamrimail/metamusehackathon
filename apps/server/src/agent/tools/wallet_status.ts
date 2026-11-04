import { z } from 'zod';
import { getWallet } from '../wallet.ts';
import { defineTool } from './types.ts';

export default defineTool({
  name: 'wallet_status',
  description: "The user's mock wallet: balance, per-action limit, monthly budget and what is left.",
  risk: 'read',
  schema: z.object({}),
  async execute(ctx) {
    const w = await getWallet(ctx.db, ctx.ipersonId);
    if (!w) return { error: 'no wallet set up' };
    const spent = w.spentMonth === ctx.now.toISOString().slice(0, 7) ? w.spentThisMonthCents : 0;
    const amt = (c: number) => `${(c / 100).toFixed(2)} ${w.currency}`;
    return {
      balance: amt(w.balanceCents),
      per_action_limit: amt(w.perActionLimitCents),
      monthly_budget: amt(w.monthlyBudgetCents),
      left_this_month: amt(Math.max(w.monthlyBudgetCents - spent, 0)),
      simulated: true,
    };
  },
});
