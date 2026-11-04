import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import findOpportunities, { cityFromTimezone, keepSourced } from '../src/agent/tools/find_opportunities.ts';
import paperTrade from '../src/agent/tools/paper_trade.ts';
import placeOrder from '../src/agent/tools/place_order.ts';
import { portfolio } from '../src/agent/tools/portfolio_status.ts';
import sendEmail from '../src/agent/tools/send_email.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';
import { eq } from 'drizzle-orm';
import { meteredLlm } from '../src/billing/credits.ts';
import { actions, aiUsage, users } from '../src/db/schema.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import type { Llm, SearchRequest } from '../src/meta/llm.ts';
import { makeIperson, reset, testDb } from './helpers.ts';

const { db, pool } = testDb();
afterAll(() => pool.end());
let ctx: ToolContext;

beforeEach(async () => {
  await reset(db);
  const { iperson } = await makeIperson(db);
  ctx = { db, llm: new DemoLlm(), ipersonId: iperson.id, userName: 'Merry', timezone: 'Africa/Tunis', now: new Date('2026-11-03T10:00:00Z') };
});

describe('paper_trade', () => {
  it('is labelled simulation and tracks positions and P&L', async () => {
    expect(paperTrade.summarize!({ symbol: 'META', side: 'buy', qty: 2 }, ctx)).toMatch(/^Simulation:/);
    await paperTrade.execute(ctx, { symbol: 'META', side: 'buy', qty: 2 });
    await paperTrade.execute(ctx, { symbol: 'META', side: 'buy', qty: 2 });
    const p = await portfolio(ctx);
    expect(p.simulation).toBe(true);
    expect(p.positions).toMatchObject([{ symbol: 'META', qty: 4 }]);
    await expect(paperTrade.execute(ctx, { symbol: 'META', side: 'sell', qty: 9 })).rejects.toThrow(/not enough/);
    const sold = await paperTrade.execute(ctx, { symbol: 'META', side: 'sell', qty: 4 }) as { realized_pnl: number };
    expect(typeof sold.realized_pnl).toBe('number');
    expect((await portfolio(ctx)).positions).toHaveLength(0);
  });

  it('rejects unknown symbols when proposing', () => {
    expect(() => paperTrade.summarize!({ symbol: 'XYZ', side: 'buy', qty: 1 }, ctx)).toThrow(/unknown symbol/);
  });
});

describe('place_order', () => {
  it('checks that items add up to the total it was approved for', async () => {
    const args = { merchant: 'Pizzeria', items: [{ name: 'Pizza', qty: 2, price: 12.5 }], total: 30, currency: 'TND' };
    await expect(placeOrder.execute(ctx, args)).rejects.toThrow(/add up/);
    expect(placeOrder.amount!(args)).toEqual({ cents: 3000, currency: 'TND' });
  });
});

describe('send_email', () => {
  const verify = () => db.update(users).set({ phoneE164: '+21699000111', verifiedAt: new Date() });
  const sendDone = (to: string[], minutesAgo: number) => db.insert(actions).values({ ipersonId: ctx.ipersonId, tool: 'send_email', args: { to, subject: 's', body: 'b' }, risk: 'write', status: 'done', summary: 'e', confirmToken: `t${Math.random()}`, expiresAt: new Date(), decidedAt: new Date(ctx.now.getTime() - minutesAgo * 60_000) });

  it('needs a verified sender, at most 5 recipients, and respects the hourly limit (new recipients count double)', async () => {
    const one = ['a@example.com'];
    expect(await sendEmail.check!(ctx, { to: one, subject: 's', body: 'b' })).toMatch(/verified WhatsApp/);
    await verify();
    expect(await sendEmail.check!(ctx, { to: one, subject: 's', body: 'b' })).toBeNull();
    expect(await sendEmail.check!(ctx, { to: ['1@x.io', '2@x.io', '3@x.io', '4@x.io', '5@x.io', '6@x.io'], subject: 's', body: 'b' })).toMatch(/at most 5 recipients/i);
    // Two first-time emails (2 + 2) and one repeat (1) in the last hour = 5: the next one is refused.
    await sendDone(['p@example.com'], 50);
    await sendDone(['q@example.com'], 40);
    await sendDone(['p@example.com'], 30);
    expect(await sendEmail.check!(ctx, { to: ['p@example.com'], subject: 's', body: 'b' })).toMatch(/at most 5 per hour/);
    await db.update(users).set({ emailSuspendedAt: new Date() });
    expect(await sendEmail.check!(ctx, { to: one, subject: 's', body: 'b' })).toMatch(/suspended/);
  });

  it('the runtime refuses to even propose a blocked email', async () => {
    const { AgentRuntime } = await import('../src/agent/runtime.ts');
    const { FakeLlm, call, say } = await import('./helpers.ts');
    const llm = new FakeLlm([call('send_email', { to: ['a@example.com'], subject: 'Hi', body: 'Hello' }), say('I can’t send it yet.')]);
    const rt = new AgentRuntime({ db, llm });
    const conversationId = await rt.conversationFor(ctx.ipersonId, 'web');
    const res = await rt.handleUserMessage({ ipersonId: ctx.ipersonId, conversationId, text: 'email a' });
    expect(res.proposed).toHaveLength(0);
    expect(String(llm.calls[1]!.messages.at(-2)!.content)).toMatch(/cannot propose: Sending email needs a verified WhatsApp number/);
  });

  it('signs as the i-person and uses the outbox without SMTP', async () => {
    await verify();
    const r = await sendEmail.execute(ctx, { to: ['a@example.com'], subject: 'Party', body: 'Come!' }) as { outbox: boolean; text: string };
    expect(r.outbox).toBe(true);
    expect(r.text).toContain("— sent by Merry's i-person");
  });
});

describe('demo model', () => {
  it('proposes bookings for the named weekday', async () => {
    const llm = new DemoLlm(() => new Date('2026-11-02T09:00:00Z')); // a Monday
    const res = await llm.complete({ messages: [{ role: 'user', content: 'book yoga thursday 7pm' }], tools: [{ name: 'x', description: '', parameters: {} }] });
    expect(JSON.parse(res.toolCalls[0]!.arguments)).toMatchObject({ start: '2026-11-05T19:00', end: '2026-11-05T20:00' });
  });
});


describe('find_opportunities', () => {
  const answer = JSON.stringify({ items: [
    { title: 'Club Orange Soukra', url: 'https://www.gyms1.com/TN/Soukra/club', when: 'Sundays' },
    { title: 'Made-up Open Play', url: 'https://invented.example/open-play', price: '10 TND' },
    { title: 'No link at all' },
  ] });
  const searching = (seen: SearchRequest[]): Llm => ({
    complete: async () => { throw new Error('should search, not guess'); },
    search: async (req) => {
      seen.push(req);
      return { text: `Here you go: ${answer}`, sources: ['https://gyms1.com/TN/Soukra/other-page'], usage: { input: 9_000, cachedInput: 4_000, output: 1_000 } };
    },
  });

  it('searches near the user and keeps only results the search really returned', async () => {
    const seen: SearchRequest[] = [];
    const res = await findOpportunities.execute({ ...ctx, llm: searching(seen) }, { kind: 'class', query: 'table tennis this weekend' }) as { items: { title: string }[]; source: string };
    expect(res.items.map((i) => i.title)).toEqual(['Club Orange Soukra']);
    expect(res.source).toBe('web search');
    expect(seen[0]!.location).toMatchObject({ city: 'Tunis', timezone: 'Africa/Tunis' });
    expect(seen[0]!.input).toContain('Near: Tunis');
    expect(cityFromTimezone('America/New_York')).toBe('New York');
  });

  it('drops home-page links and free-hosting lookalikes', () => {
    const items = [
      { title: 'Raid on Tunis office', url: 'https://c21media.net' },
      { title: 'Lookalike', url: 'https://aljazeerah.pages.dev/news/1' },
      { title: 'Article', url: 'https://www.aljazeera.com/news/2026/10/31/raid' },
    ];
    const sources = ['https://c21media.net/', 'https://aljazeerah.pages.dev/', 'https://aljazeera.com/news'];
    expect(keepSourced(items, sources).map((i) => i.title)).toEqual(['Article']);
  });

  it('says nothing was found rather than inventing', async () => {
    const llm: Llm = { complete: async () => ({ content: '', toolCalls: [] }), search: async () => ({ text: answer, sources: [] }) };
    expect(await findOpportunities.execute({ ...ctx, llm }, { kind: 'deal', query: 'x' })).toMatchObject({ items: [], note: expect.stringContaining('do not make anything up') });
  });

  it("charges the search to the user's credit", async () => {
    const [user] = await db.select().from(users);
    await db.update(users).set({ aiCreditMicros: 5_000_000 }).where(eq(users.id, user!.id));
    const llm = meteredLlm(searching([]), db, user!.id, 'muse-spark-1.3');
    await findOpportunities.execute({ ...ctx, llm }, { kind: 'class', query: 'table tennis' });
    const [row] = await db.select().from(aiUsage);
    // 5000 × 1.25 + 4000 × 0.15 + 1000 × 4.25 per 1M = $0.0111
    expect(row).toMatchObject({ kind: 'llm', metaCostMicros: 11_100, feeMicros: 11_100 });
  });
});
