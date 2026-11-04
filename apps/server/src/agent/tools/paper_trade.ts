import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { paperPositions } from '../../db/schema.ts';
import { lastPrice, SYMBOLS } from './market.ts';
import { defineTool } from './types.ts';

export default defineTool({
  name: 'paper_trade',
  description: `SIMULATION ONLY: paper-trade a symbol at the simulated last price. Symbols: ${SYMBOLS.join(', ')}. Needs confirmation.`,
  risk: 'money',
  schema: z.object({
    symbol: z.string().transform((s) => s.toUpperCase()),
    side: z.enum(['buy', 'sell']),
    qty: z.number().positive(),
  }),
  summarize: (a, ctx) => {
    const p = lastPrice(a.symbol, ctx.now);
    if (p === undefined) throw new Error(`unknown symbol ${a.symbol}; use one of ${SYMBOLS.join(', ')}`);
    return `Simulation: ${a.side} ${a.qty} ${a.symbol} at ~${p.toFixed(2)} USD (paper trade)`;
  },
  async execute(ctx, a) {
    const price = lastPrice(a.symbol, ctx.now);
    if (price === undefined) throw new Error(`unknown symbol ${a.symbol}`);
    const open = and(eq(paperPositions.ipersonId, ctx.ipersonId), eq(paperPositions.symbol, a.symbol), isNull(paperPositions.closedAt));
    const [pos] = await ctx.db.select().from(paperPositions).where(open);

    if (a.side === 'buy') {
      if (pos) {
        const qty = Number(pos.qty) + a.qty;
        const avg = (Number(pos.qty) * Number(pos.avgPrice) + a.qty * price) / qty;
        await ctx.db.update(paperPositions).set({ qty: String(qty), avgPrice: avg.toFixed(4) }).where(eq(paperPositions.id, pos.id));
      } else {
        await ctx.db.insert(paperPositions).values({ ipersonId: ctx.ipersonId, symbol: a.symbol, qty: String(a.qty), avgPrice: price.toFixed(4) });
      }
      return { simulation: true, filled: a.qty, symbol: a.symbol, price };
    }

    if (!pos || Number(pos.qty) < a.qty) throw new Error(`not enough ${a.symbol} to sell (have ${pos ? Number(pos.qty) : 0})`);
    const pnl = (price - Number(pos.avgPrice)) * a.qty;
    const left = Number(pos.qty) - a.qty;
    await ctx.db.update(paperPositions).set(left > 0
      ? { qty: String(left), pnl: String(Number(pos.pnl ?? 0) + pnl) }
      : { qty: '0', pnl: String(Number(pos.pnl ?? 0) + pnl), closedAt: ctx.now },
    ).where(eq(paperPositions.id, pos.id));
    return { simulation: true, filled: a.qty, symbol: a.symbol, price, realized_pnl: Math.round(pnl * 100) / 100 };
  },
});
