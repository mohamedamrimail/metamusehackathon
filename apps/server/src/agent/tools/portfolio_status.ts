import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { paperPositions } from '../../db/schema.ts';
import { lastPrice } from './market.ts';
import { defineTool } from './types.ts';

export async function portfolio(ctx: { db: import('../../db/client.ts').Db; ipersonId: string; now: Date }) {
  const rows = await ctx.db.select().from(paperPositions)
    .where(and(eq(paperPositions.ipersonId, ctx.ipersonId), isNull(paperPositions.closedAt)));
  const positions = rows.map((p) => {
    const price = lastPrice(p.symbol, ctx.now) ?? Number(p.avgPrice);
    const qty = Number(p.qty);
    return {
      symbol: p.symbol, qty, avg_price: Number(p.avgPrice), last_price: price,
      unrealized_pnl: Math.round((price - Number(p.avgPrice)) * qty * 100) / 100,
    };
  });
  return { simulation: true, currency: 'USD', positions };
}

export default defineTool({
  name: 'portfolio_status',
  description: 'The SIMULATED paper-trading portfolio with unrealized P&L.',
  risk: 'read',
  schema: z.object({}),
  execute: (ctx) => portfolio(ctx),
});
