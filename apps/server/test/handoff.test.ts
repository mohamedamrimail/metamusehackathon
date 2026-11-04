import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.ts';
import { amazonAddToCartUrl, amazonProductUrl } from '../src/agent/tools/deeplinks/amazon.ts';
import { bookingSearchUrl } from '../src/agent/tools/deeplinks/booking.ts';
import { skyscannerUrl } from '../src/agent/tools/deeplinks/skyscanner.ts';
import bookingsList from '../src/agent/tools/bookings_list.ts';
import findOffers from '../src/agent/tools/find_offers.ts';
import ordersList from '../src/agent/tools/orders_list.ts';
import prepareCheckout, { checkoutSender } from '../src/agent/tools/prepare_checkout.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';
import { bookings, purchases } from '../src/db/schema.ts';
import type { Llm } from '../src/meta/llm.ts';
import { call, FakeLlm, makeIperson, reset, say, testDb } from './helpers.ts';

const { db, pool } = testDb();
afterAll(() => pool.end());
let ctx: ToolContext;
let userId: string;
beforeEach(async () => {
  await reset(db);
  const { iperson, user } = await makeIperson(db);
  userId = user.id;
  ctx = { db, llm: new FakeLlm([]), ipersonId: iperson.id, userName: 'Merry', timezone: 'Europe/Berlin', now: new Date('2026-11-01T10:00:00Z') };
});

describe('deeplink builders', () => {
  it('build the providers\' prefilled URLs', () => {
    expect(bookingSearchUrl({ city: 'Munich', checkin: '2026-11-14', checkout: '2026-11-16', stars: 4, freeCancellation: true }))
      .toBe('https://www.booking.com/searchresults.html?ss=Munich&checkin=2026-11-14&checkout=2026-11-16&group_adults=2&no_rooms=1&group_children=0&nflt=class%3D4%3Bfc%3D2');
    expect(skyscannerUrl({ from: 'TUN', to: 'fra', depart: '2026-11-14', returnDate: '2026-11-16' }))
      .toBe('https://www.skyscanner.net/transport/flights/tun/fra/261114/261116/?adultsv2=1&cabinclass=economy');
    expect(amazonProductUrl('B07PGL2ZSL')).toBe('https://www.amazon.de/dp/B07PGL2ZSL');
    expect(amazonAddToCartUrl('B07PGL2ZSL', 2)).toBe('https://www.amazon.de/gp/aws/cart/add.html?ASIN.1=B07PGL2ZSL&Quantity.1=2');
  });
  it('refuse bad input', () => {
    expect(() => bookingSearchUrl({ city: 'X', checkin: '2026-11-16', checkout: '2026-11-14' })).toThrow();
    expect(() => skyscannerUrl({ from: 'TUNIS', to: 'FRA', depart: '2026-11-14' })).toThrow();
    expect(() => amazonAddToCartUrl('javascript:x')).toThrow();
  });
});

describe('orders_list / bookings_list', () => {
  it('list learned purchases and upcoming bookings', async () => {
    await db.insert(purchases).values({ userId, providerRef: '302-1', merchant: 'Amazon.de', title: 'Coffee capsules 50x', itemRef: 'B00COFFEE1', amountCents: 1999, currency: 'EUR', orderedAt: new Date('2026-10-01') });
    await db.insert(bookings).values([
      { userId, providerRef: 'B1', kind: 'hotel', title: 'Hotel Am Bahnhof', city: 'Munich', stars: 4, nights: 2, startAt: new Date('2026-11-20'), freeCancellation: true },
      { userId, providerRef: 'B0', kind: 'hotel', title: 'Old stay', city: 'Munich', startAt: new Date('2026-09-01') },
    ]);
    expect(await ordersList.execute(ctx, { query: 'coffee', limit: 10 })).toEqual({ orders: [{ merchant: 'Amazon.de', item: 'Coffee capsules 50x', asin: 'B00COFFEE1', quantity: 1, price: '19.99 EUR', ordered: '2026-10-01' }] });
    const up = await bookingsList.execute(ctx, { when: 'upcoming', limit: 10 }) as { bookings: { title: string }[] };
    expect(up.bookings.map((b) => b.title)).toEqual(['Hotel Am Bahnhof']);
  });
});

describe('find_offers', () => {
  it('keeps only real links on the provider and adds the prefilled search', async () => {
    const llm: Llm = {
      complete: async () => ({ content: '', toolCalls: [] }),
      search: async (req) => {
        expect(req.instructions).toContain('site:booking.com');
        return { text: JSON.stringify({ items: [{ title: 'Hotel Laimer Hof', price: '€118/night', url: 'https://www.booking.com/hotel/de/laimer-hof.html' }, { title: 'Made up', url: 'https://www.booking.com/hotel/de/fake.html' }, { title: 'Elsewhere', url: 'https://hotels.example/x' }] }), sources: ['https://www.booking.com/hotel/de/laimer-hof.html', 'https://hotels.example/x'] };
      },
    };
    const r = await findOffers.execute({ ...ctx, llm }, { provider: 'booking', query: 'hotel', city: 'Munich', checkin: '2026-11-14', checkout: '2026-11-16', stars: 4 }) as { options: { title: string }[]; prefilled_search: string };
    // booking.com hosts are all in the sources, so both booking links pass the host check; the off-site one is dropped.
    expect(r.options.map((o) => o.title)).toEqual(['Hotel Laimer Hof', 'Made up']);
    expect(r.prefilled_search).toContain('ss=Munich');
  });
});

describe('prepare_checkout', () => {
  it('accepts numbers sent as strings (the eval found Muse Spark does that)', () => {
    const parsed = prepareCheckout.schema.safeParse({ provider: 'amazon', asin: 'B07PGL2ZSL', item: 'Coffee capsules', quantity: '2' });
    expect(parsed.success && (parsed.data as { quantity: number }).quantity).toBe(2);
    expect(prepareCheckout.schema.safeParse({ provider: 'amazon', asin: 'B07PGL2ZSL', item: 'x', quantity: 'two' }).success).toBe(false);
  });

  it('is only a proposal until approved; then the link goes to the user', async () => {
    const sent: string[] = [];
    checkoutSender.send = async (_ip, text) => { sent.push(text); };
    const llm = new FakeLlm([call('prepare_checkout', { provider: 'booking', city: 'Munich', checkin: '2026-11-14', checkout: '2026-11-16', stars: 4, free_cancellation: true }), say('I prepared it.')], say('Done.'));
    const rt = new AgentRuntime({ db, llm });
    const conversationId = await rt.conversationFor(ctx.ipersonId, 'web');
    const res = await rt.handleUserMessage({ ipersonId: ctx.ipersonId, conversationId, text: 'hotel in Munich like last time' });
    expect(res.proposed[0]!.summary).toBe('Prepare Booking.com: hotels in Munich, 2026-11-14 → 2026-11-16, 2 adults, 4★, free cancellation');
    expect(sent).toHaveLength(0);
    const d = await rt.decide({ ipersonId: ctx.ipersonId, actionId: res.proposed[0]!.id, approve: true });
    expect(d.action.status).toBe('done');
    expect(sent[0]).toMatch(/^Ready on Booking\.com — finish it there: https:\/\/www\.booking\.com\/searchresults\.html\?ss=Munich/);
    expect(prepareCheckout.risk).toBe('write');
  });
});

describe('prepare_checkout learns from past stays', () => {
  it('adds stars and free cancellation from earlier stays in that city', async () => {
    for (const [ref, stars] of [['A', 4], ['B', 4], ['C', 3]] as const) await db.insert(bookings).values({ userId, providerRef: ref, kind: 'hotel', title: 'x', city: 'Munich', stars, freeCancellation: true, startAt: new Date('2026-06-01') });
    const llm = new FakeLlm([call('prepare_checkout', { provider: 'booking', city: 'munich', checkin: '2026-11-14', checkout: '2026-11-16' }), say('ok')]);
    const rt = new AgentRuntime({ db, llm });
    const conversationId = await rt.conversationFor(ctx.ipersonId, 'web');
    const res = await rt.handleUserMessage({ ipersonId: ctx.ipersonId, conversationId, text: 'like last time' });
    expect(res.proposed[0]!.summary).toBe('Prepare Booking.com: hotels in munich, 2026-11-14 → 2026-11-16, 2 adults, 4★, free cancellation');
  });
});
