import { and, desc, eq, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { ipersons, purchases } from '../../db/schema.ts';
import { defineTool } from './types.ts';

export default defineTool({
  name: 'orders_list',
  description: 'Recent purchases learned from the user\'s order emails (Amazon.de etc.): item, ASIN, price, date. Filter by merchant or words in the item.',
  risk: 'read',
  // Learned from emails: shown to the model as outside data, so it can't plant memories.
  external: 'your emails',
  schema: z.object({ merchant: z.string().max(60).optional(), query: z.string().max(60).optional(), limit: z.number().int().min(1).max(30).default(10) }),
  async execute(ctx, a) {
    const [ip] = await ctx.db.select({ userId: ipersons.userId }).from(ipersons).where(eq(ipersons.id, ctx.ipersonId));
    const rows = await ctx.db.select().from(purchases).where(and(
      eq(purchases.userId, ip!.userId),
      a.merchant ? ilike(purchases.merchant, `%${a.merchant}%`) : undefined,
      a.query ? ilike(purchases.title, `%${a.query}%`) : undefined,
    )).orderBy(desc(purchases.orderedAt)).limit(a.limit);
    return { orders: rows.map((p) => ({ merchant: p.merchant, item: p.title, asin: p.itemRef, quantity: p.quantity, price: p.amountCents != null ? `${(p.amountCents / 100).toFixed(2)} ${p.currency ?? ''}`.trim() : null, ordered: p.orderedAt.toISOString().slice(0, 10) })) };
  },
});
