import { demoFlights, demoProducts, demoServiceFor, demoStays } from '@ipersons/shared';
import { z } from 'zod';
import { demoHandoffUrl } from './deeplinks/demo.ts';
import { listFacts } from '../memory.ts';
import { amazonProductUrl } from './deeplinks/amazon.ts';
import { bookingSearchUrl } from './deeplinks/booking.ts';
import { skyscannerUrl } from './deeplinks/skyscanner.ts';
import { keepSourced } from './find_opportunities.ts';
import { defineTool } from './types.ts';

// 5d: offers on one provider, shaped by what the twin learned (stars, nights, free cancellation…):
// real search results restricted to the provider's site (only linked results kept) + a prefilled search.

const SITES = { booking: 'booking.com', skyscanner: 'skyscanner.net', amazon: 'amazon.de' } as const;

/**
 * DEMO: demo accounts search the neutral demo service's sample listings (no web search, no real hotel or
 * shop names); the prefilled search opens the demo page.
 */
function demoOffers(a: { provider: 'booking' | 'skyscanner' | 'amazon'; query: string; city?: string; checkin?: string; checkout?: string; adults?: number; stars?: number; free_cancellation?: boolean; from?: string; to?: string; depart?: string; return_date?: string; asin?: string }) {
  const service = demoServiceFor(a.provider)!.name;
  if (a.provider === 'booking') {
    const city = a.city ?? a.query.replace(/^.*\bin\s+/i, '').trim();
    const options = demoStays(city, { stars: a.stars, freeCancellation: a.free_cancellation })
      .map((s) => ({ title: s.title, why: `${s.area}, rated ${s.rating.toFixed(1)}${s.freeCancellation ? ', free cancellation' : ''}`, price: `€${s.pricePerNight} a night`, when: a.checkin ? `${a.checkin} → ${a.checkout}` : undefined }));
    return { provider: service, options, prefilled_search: demoHandoffUrl('booking', { city, checkin: a.checkin, checkout: a.checkout, adults: a.adults, stars: a.stars, fc: a.free_cancellation }) };
  }
  if (a.provider === 'skyscanner') {
    const options = a.from && a.to ? demoFlights(a.from, a.to).map((f) => ({ title: f.title, why: `${f.depart} → ${f.arrive}`, price: `€${f.price}`, when: a.depart })) : [];
    return { provider: service, options, prefilled_search: a.from && a.to ? demoHandoffUrl('skyscanner', { from: a.from.toUpperCase(), to: a.to.toUpperCase(), depart: a.depart, return: a.return_date, adults: a.adults }) : null };
  }
  const options = demoProducts(a.query, a.asin).map((p) => ({ title: p.title, why: p.note, price: `€${p.price.toFixed(2)}`, ref: p.ref }));
  return { provider: service, options, prefilled_search: demoHandoffUrl('amazon', { ref: options[0]?.ref, item: options[0]?.title, qty: 1 }) };
}

export default defineTool({
  name: 'find_offers',
  description: 'Find real offers on Booking.com, Skyscanner or Amazon.de that fit the user\'s learned preferences. Returns options with real links and a prefilled search link. Never invent prices.',
  risk: 'read',
  external: 'web search',
  demoExternal: 'service listings',
  schema: z.object({
    provider: z.enum(['booking', 'skyscanner', 'amazon']),
    query: z.string().min(2).max(200).describe('e.g. "hotel in Munich" or "coffee capsules"'),
    city: z.string().max(80).optional(), checkin: z.string().optional(), checkout: z.string().optional(), adults: z.coerce.number().int().min(1).max(9).optional(),
    stars: z.coerce.number().min(1).max(5).optional(), free_cancellation: z.boolean().optional(),
    from: z.string().length(3).optional(), to: z.string().length(3).optional(), depart: z.string().optional(), return_date: z.string().optional(),
    asin: z.string().optional(),
  }),
  async execute(ctx, a) {
    if (ctx.demo) return demoOffers(a);
    const facts = await listFacts(ctx.db, ctx.ipersonId, { limit: 40 });
    const learned = facts.filter((f) => f.source === 'mailbox' || f.category === 'preference').map((f) => `- ${f.value}`).join('\n');
    let search: string | undefined;
    try {
      if (a.provider === 'booking' && a.city && a.checkin && a.checkout) search = bookingSearchUrl({ city: a.city, checkin: a.checkin, checkout: a.checkout, adults: a.adults, stars: a.stars, freeCancellation: a.free_cancellation });
      if (a.provider === 'skyscanner' && a.from && a.to && a.depart) search = skyscannerUrl({ from: a.from, to: a.to, depart: a.depart, returnDate: a.return_date, adults: a.adults });
      if (a.provider === 'amazon' && a.asin) search = amazonProductUrl(a.asin);
    } catch { /* incomplete details: results only */ }

    let items: { title: string; why?: string; price?: string; when?: string; url?: string }[] = [];
    if (ctx.llm.search) {
      const res = await ctx.llm.search({
        instructions: `Find current offers on ${SITES[a.provider]} only. Do one or two searches with site:${SITES[a.provider]} and answer from the result snippets; do not open pages. Reply with JSON only: {"items":[{"title","why","price","when","url"}]} (max 5). Only include prices shown in the results. Every url must be a ${SITES[a.provider]} page from your results.`,
        input: `Looking for: ${a.query}${a.city ? ` in ${a.city}` : ''}${a.checkin ? ` from ${a.checkin} to ${a.checkout}` : ''}\nWhat the person usually likes:\n${learned || '- (nothing learned yet)'}`,
      });
      const json = /\{[\s\S]*\}/.exec(res.text)?.[0];
      try {
        const parsed = json ? (JSON.parse(json) as { items?: typeof items }) : {};
        items = keepSourced(parsed.items ?? [], res.sources).filter((i) => i.url?.includes(SITES[a.provider].split('.')[0]!));
      } catch { /* nothing usable */ }
    }
    return { provider: a.provider, options: items, prefilled_search: search ?? null, note: items.length ? undefined : 'no reliable listing found; offer the prefilled search instead, never make up options' };
  },
});
