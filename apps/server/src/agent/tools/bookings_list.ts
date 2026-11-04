import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import { z } from 'zod';
import { bookings, ipersons } from '../../db/schema.ts';
import { defineTool } from './types.ts';

export default defineTool({
  name: 'bookings_list',
  description: 'Hotel stays and flights learned from the user\'s booking emails (Booking.com, Skyscanner, airlines): upcoming or past.',
  risk: 'read',
  // Learned from emails: shown to the model as outside data, so it can't plant memories.
  external: 'your emails',
  schema: z.object({ when: z.enum(['upcoming', 'past']).default('upcoming'), kind: z.enum(['hotel', 'flight']).optional(), limit: z.number().int().min(1).max(30).default(10) }),
  async execute(ctx, a) {
    const [ip] = await ctx.db.select({ userId: ipersons.userId }).from(ipersons).where(eq(ipersons.id, ctx.ipersonId));
    const rows = await ctx.db.select().from(bookings).where(and(
      eq(bookings.userId, ip!.userId),
      a.kind ? eq(bookings.kind, a.kind) : undefined,
      a.when === 'upcoming' ? gte(bookings.startAt, ctx.now) : lt(bookings.startAt, ctx.now),
    )).orderBy(a.when === 'upcoming' ? asc(bookings.startAt) : desc(bookings.startAt)).limit(a.limit);
    return { bookings: rows.map((b) => ({ kind: b.kind, title: b.title, city: b.city, route: b.routeFrom && b.routeTo ? `${b.routeFrom}-${b.routeTo}` : null, stars: b.stars, nights: b.nights, start: b.startAt?.toISOString().slice(0, 10), end: b.endAt?.toISOString().slice(0, 10), free_cancellation: b.freeCancellation })) };
  },
});
