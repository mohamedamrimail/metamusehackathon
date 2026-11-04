import { and, eq, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { bookings, ipersons, users } from '../../db/schema.ts';
import { amazonAddToCartUrl, amazonProductUrl } from './deeplinks/amazon.ts';
import { bookingSearchUrl } from './deeplinks/booking.ts';
import { skyscannerUrl } from './deeplinks/skyscanner.ts';
import { demoHandoffUrl } from './deeplinks/demo.ts';
import { demoServiceFor } from '@ipersons/shared';
import { defineTool } from './types.ts';

// 5d: a prefilled hand-off link — the user finishes on the provider's own site. We never book or buy.
// On approval the link goes to the user on the web and on WhatsApp.

export const checkoutSender: { send?: (ipersonId: string, text: string) => Promise<void> } = {};

// Muse Spark sometimes sends numbers as strings ("quantity":"2"): numeric fields are coerced.
const Args = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('booking'), city: z.string().min(1).max(80), checkin: z.string(), checkout: z.string(), adults: z.coerce.number().int().min(1).max(9).default(2), stars: z.coerce.number().min(1).max(5).optional(), free_cancellation: z.boolean().optional() }),
  z.object({ provider: z.literal('skyscanner'), from: z.string().length(3), to: z.string().length(3), depart: z.string(), return_date: z.string().optional(), adults: z.coerce.number().int().min(1).max(9).default(1) }),
  z.object({ provider: z.literal('amazon'), asin: z.string(), item: z.string().max(120), quantity: z.coerce.number().int().min(1).max(10).default(1), add_to_cart: z.boolean().default(true) }),
]);
type A = z.infer<typeof Args>;

export function checkoutLink(a: A, demo = false): { url: string; site: string; what: string } {
  // DEMO: demo accounts get the neutral demo service and page instead of the real site.
  if (demo) {
    const real = checkoutLink(a);
    const site = demoServiceFor(a.provider)!.name;
    const url = a.provider === 'booking'
      ? demoHandoffUrl('booking', { city: a.city, checkin: a.checkin, checkout: a.checkout, adults: a.adults, stars: a.stars, fc: a.free_cancellation })
      : a.provider === 'skyscanner'
        ? demoHandoffUrl('skyscanner', { from: a.from.toUpperCase(), to: a.to.toUpperCase(), depart: a.depart, return: a.return_date, adults: a.adults })
        : demoHandoffUrl('amazon', { ref: a.asin, item: a.item, qty: a.quantity, cart: a.add_to_cart });
    return { site, url, what: real.what };
  }
  if (a.provider === 'booking') return { site: 'Booking.com', url: bookingSearchUrl({ city: a.city, checkin: a.checkin, checkout: a.checkout, adults: a.adults, stars: a.stars, freeCancellation: a.free_cancellation }), what: `hotels in ${a.city}, ${a.checkin} → ${a.checkout}, ${a.adults} adult${a.adults > 1 ? 's' : ''}${a.stars ? `, ${a.stars}★` : ''}${a.free_cancellation ? ', free cancellation' : ''}` };
  if (a.provider === 'skyscanner') return { site: 'Skyscanner', url: skyscannerUrl({ from: a.from, to: a.to, depart: a.depart, returnDate: a.return_date, adults: a.adults }), what: `flights ${a.from.toUpperCase()} → ${a.to.toUpperCase()}, ${a.depart}${a.return_date ? ` – ${a.return_date}` : ''}` };
  return { site: 'Amazon.de', url: a.add_to_cart ? amazonAddToCartUrl(a.asin, a.quantity) : amazonProductUrl(a.asin), what: `${a.quantity} × ${a.item}${a.add_to_cart ? ' in your cart' : ''}` };
}

export default defineTool({
  name: 'prepare_checkout',
  description: 'Prepare a prefilled link on Booking.com (hotel search), Skyscanner (flight search) or Amazon.de (product / add to cart) for the user to finish there. Needs confirmation. Put what you know the user likes into the link (for hotels: stars and free_cancellation from their past stays). You never book or buy: say you prepared it.',
  risk: 'write',
  schema: Args,
  // "Like last time": a hotel search without stars / cancellation preference gets them from past stays there.
  async prepare(ctx, a) {
    if (a.provider !== 'booking' || (a.stars !== undefined && a.free_cancellation !== undefined)) return a;
    const [ip] = await ctx.db.select({ userId: ipersons.userId }).from(ipersons).where(eq(ipersons.id, ctx.ipersonId));
    const stays = await ctx.db.select().from(bookings).where(and(eq(bookings.userId, ip!.userId), eq(bookings.kind, 'hotel'), ilike(bookings.city, a.city)));
    if (!stays.length) return a;
    const stars = stays.map((s) => s.stars).filter((x): x is number => x != null).sort((x, y) => x - y);
    const fc = stays.filter((s) => s.freeCancellation).length / stays.length;
    return { ...a, stars: a.stars ?? (stars.length ? stars[Math.floor(stars.length / 2)] : undefined), free_cancellation: a.free_cancellation ?? (fc >= 0.5 ? true : undefined) };
  },
  summarize: (a, ctx) => { const l = checkoutLink(a, ctx.demo); return `Prepare ${l.site}: ${l.what}`; },
  async execute(ctx, a) {
    const l = checkoutLink(a, ctx.demo);
    const text = `Ready on ${l.site} — finish it there: ${l.url}`;
    await checkoutSender.send?.(ctx.ipersonId, text);
    const [row] = await ctx.db.select({ phone: users.phoneE164 }).from(ipersons).innerJoin(users, eq(users.id, ipersons.userId)).where(eq(ipersons.id, ctx.ipersonId));
    return { prepared: true, site: l.site, link: l.url, sent_to_whatsapp: Boolean(row?.phone) };
  },
});
