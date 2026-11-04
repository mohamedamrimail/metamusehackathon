import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from './types.ts';

// HACKATHON: mock merchant. The wallet debit is real (in the mock wallet); no order leaves the system.

export default defineTool({
  name: 'place_order',
  description: 'Order items from a merchant, paid from the mock wallet. Needs confirmation; never invent prices.',
  risk: 'money',
  schema: z.object({
    merchant: z.string().min(1).max(120),
    items: z.array(z.object({ name: z.string().min(1), qty: z.number().int().positive(), price: z.number().nonnegative() })).min(1),
    total: z.number().positive(),
    currency: z.string().length(3).default('TND'),
  }),
  amount: (a) => ({ cents: Math.round(a.total * 100), currency: a.currency.toUpperCase() }),
  summarize: (a) =>
    `Order ${a.items.map((i) => `${i.qty}× ${i.name}`).join(', ')} from ${a.merchant} for ${a.total.toFixed(2)} ${a.currency.toUpperCase()}`,
  async execute(_ctx, a) {
    const sum = a.items.reduce((s, i) => s + i.qty * i.price, 0);
    if (Math.abs(sum - a.total) > 0.01) throw new Error(`items add up to ${sum.toFixed(2)}, not ${a.total.toFixed(2)}`);
    return { ordered: true, order_id: `ORD-${randomBytes(3).toString('hex').toUpperCase()}`, merchant: a.merchant, simulated_merchant: true };
  },
});
