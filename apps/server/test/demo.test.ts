import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import findOffers from '../src/agent/tools/find_offers.ts';
import prepareCheckout from '../src/agent/tools/prepare_checkout.ts';
import sendEmail from '../src/agent/tools/send_email.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';
import { isFictionalNumber } from '../src/channels/whatsapp-client.ts';
import { config } from '../src/config.ts';
import { users } from '../src/db/schema.ts';
import type { AppDeps } from '../src/http/deps.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { ensureDemoConnectors } from '../scripts/video-demo-data.ts';
import { FakeLlm, makeIperson, reset, say, testDb, testGeo } from './helpers.ts';

// Demo accounts (account_kind 'demo', the video and judges' personas): neutral demo services instead of
// real brands. Real users must never see any of it.

const { db, pool } = testDb();
let app: FastifyInstance;
let deps: AppDeps;
let llm: FakeLlm;

beforeEach(async () => {
  await reset(db);
  await ensureDemoConnectors(db);
  await app?.close();
  llm = new FakeLlm([], say('ok'));
  deps = createDeps(db, { geo: testGeo, llm, stt: undefined, demoMode: true });
  app = buildApp(deps);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function signUp(email: string, kind: 'user' | 'demo') {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name: 'Merry' } });
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  await db.update(users).set({ accountKind: kind, phoneE164: `+2165${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, phoneCountry: 'TN', verifiedAt: new Date() }).where(eq(users.email, email));
  const ip = await app.inject({ method: 'POST', url: '/api/ipersons', headers: { cookie }, payload: { display_name: 'Mimi', locale: 'en', timezone: 'Europe/Berlin' } });
  return { cookie, ipersonId: ip.json().iperson.id as string };
}
const slugs = async (cookie: string) => (await app.inject({ url: '/api/store', headers: { cookie } })).json().services.map((s: { slug: string }) => s.slug) as string[];

describe('demo services in the Store', () => {
  it('real users never see or activate them', async () => {
    const { cookie } = await signUp('real@example.com', 'user');
    const list = await slugs(cookie);
    expect(list).toEqual(['yousoft', 'amazon-de', 'booking', 'skyscanner']);
    expect((await app.inject({ method: 'POST', url: '/api/store/demo-stayfinder/activate', headers: { cookie } })).statusCode).toBe(404);
  });

  it('demo accounts see only the neutral services and partner organisations, no real brands', async () => {
    const { cookie } = await signUp('demo@example.com', 'demo');
    const list = await slugs(cookie);
    expect(list).toEqual(expect.arrayContaining(['demo-stayfinder', 'demo-flynow', 'demo-shopmate', 'yousoft']));
    expect(list).not.toContain('booking');
    expect(list).not.toContain('amazon-de');
    expect((await app.inject({ method: 'POST', url: '/api/store/booking/activate', headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/store/demo-shopmate/activate', headers: { cookie } })).json()).toMatchObject({ service: { name: 'ShopMate', active: true } });
  });

  it('only demo accounts may pick the neutral sources', async () => {
    const real = await signUp('real@example.com', 'user');
    expect((await app.inject({ method: 'PUT', url: `/api/ipersons/${real.ipersonId}/sources`, headers: { cookie: real.cookie }, payload: { providers: ['stayfinder'] } })).statusCode).toBe(400);
    const demo = await signUp('demo@example.com', 'demo');
    expect((await app.inject({ method: 'PUT', url: `/api/ipersons/${demo.ipersonId}/sources`, headers: { cookie: demo.cookie }, payload: { providers: ['stayfinder', 'shopmate'] } })).statusCode).toBe(200);
  });
});

describe('the agent on demo accounts', () => {
  it('hears the neutral names, never the real brands; real users are unchanged', async () => {
    const demo = await signUp('demo@example.com', 'demo');
    await deps.runtime.handleUserMessage({ ipersonId: demo.ipersonId, conversationId: await deps.runtime.conversationFor(demo.ipersonId, 'web'), text: 'hotel?' });
    const sent = JSON.stringify(llm.calls[0]);
    expect(sent).toContain('StayFinder');
    expect(sent).not.toMatch(/Booking\.com|Skyscanner|Amazon/);

    const real = await signUp('real@example.com', 'user');
    await deps.runtime.handleUserMessage({ ipersonId: real.ipersonId, conversationId: await deps.runtime.conversationFor(real.ipersonId, 'web'), text: 'hotel?' });
    const realSent = JSON.stringify(llm.calls[1]);
    expect(realSent).toContain('Booking.com');
    expect(realSent).not.toMatch(/StayFinder|ShopMate|FlyNow/);
  });
});

describe('demo hand-offs', () => {
  const ctxFor = async (demo: boolean): Promise<ToolContext> => {
    const { iperson } = await makeIperson(db, { email: `${demo ? 'd' : 'r'}@example.com` });
    return { db, llm: new FakeLlm([]), ipersonId: iperson.id, userName: 'Merry', timezone: 'Europe/Berlin', now: new Date('2026-11-01T10:00:00Z'), demo };
  };
  const stay = { provider: 'booking' as const, city: 'Munich', checkin: '2026-11-03', checkout: '2026-11-05', adults: 2, stars: 4, free_cancellation: true };

  it('prepare_checkout links to the neutral demo page, prefilled, for demo accounts only', async () => {
    const demo = await ctxFor(true);
    expect(prepareCheckout.summarize!(stay, demo)).toBe('Prepare StayFinder: hotels in Munich, 2026-11-03 → 2026-11-05, 2 adults, 4★, free cancellation');
    const r = await prepareCheckout.execute(demo, stay) as { link: string; site: string };
    expect(r.site).toBe('StayFinder');
    expect(r.link).toBe(`${config.PUBLIC_URL}/demo/stay?city=Munich&checkin=2026-11-03&checkout=2026-11-05&adults=2&stars=4&fc=1`);
    const shop = await prepareCheckout.execute(demo, { provider: 'amazon', asin: 'SMCOFFEE50', item: 'Espresso capsules', quantity: 1, add_to_cart: true }) as { link: string };
    expect(shop.link).toContain('/demo/shop?ref=SMCOFFEE50');

    const real = await ctxFor(false);
    expect((await prepareCheckout.execute(real, stay) as { link: string }).link).toMatch(/^https:\/\/www\.booking\.com\//);
  });

  it('find_offers returns the demo listings without any web search', async () => {
    const demo = await ctxFor(true);
    demo.llm = { complete: async () => say(''), search: async () => { throw new Error('no web search on demo accounts'); } };
    const r = await findOffers.execute(demo, { provider: 'booking', query: 'hotel in Munich', city: 'Munich', checkin: '2026-11-03', checkout: '2026-11-05', stars: 4, free_cancellation: true }) as { provider: string; options: { title: string; price: string }[]; prefilled_search: string };
    expect(r.provider).toBe('StayFinder');
    expect(r.options).toHaveLength(3);
    expect(r.options.every((o) => o.title.startsWith('4★'))).toBe(true);
    expect(r.prefilled_search).toContain('/demo/stay?city=Munich');
  });

  it('demo accounts never send real email: the outbox keeps the signed text', async () => {
    const demo = await ctxFor(true);
    await db.update(users).set({ phoneE164: '+12025550101' }).where(eq(users.email, 'd@example.com'));
    const r = await sendEmail.execute(demo, { to: ['family@example.org'], subject: 'Lunch', body: 'Come on Sunday.' }) as { outbox: boolean; delivered: boolean; text: string };
    expect(r).toMatchObject({ outbox: true, delivered: false });
    expect(r.text).toContain("— sent by Merry's i-person");
  });

  it('fictional demo numbers are never messaged on WhatsApp', () => {
    expect(isFictionalNumber('+12025550101')).toBe(true);
    expect(isFictionalNumber('12025550199')).toBe(true);
    expect(isFictionalNumber('+12025550200')).toBe(false);
    expect(isFictionalNumber('+21650123456')).toBe(false);
  });
});

describe('demo venues for plans', () => {
  it('demo partners’ venues are offered to demo accounts only, and demo plans never search the web', async () => {
    const { connectors, partnerOffers, partners } = await import('../src/db/schema.ts');
    const { findPlaces, partnerVenues } = await import('../src/twins/places.ts');
    const { inArray } = await import('drizzle-orm');
    await db.delete(connectors).where(inArray(connectors.slug, ['demo-cafe-t'])); // the catalog isn't reset between tests
    const [c] = await db.insert(connectors).values({ slug: 'demo-cafe-t', name: 'Demo café', type: 'org', category: 'other', tagline: 't', capabilities: [], scopes: [], live: true }).returning();
    const [demoP] = await db.insert(partners).values({ slug: 'demo-cafe-t', name: 'Demo café', scopes: [], connectorId: c!.id }).returning();
    const [realP] = await db.insert(partners).values({ slug: 'real-cafe-t', name: 'Real café', scopes: [] }).returning();
    await db.insert(partnerOffers).values([
      { partnerId: demoP!.id, type: 'venue', title: 'Demo venue', description: 'demo', location: 'Le Marais, Paris' },
      { partnerId: realP!.id, type: 'venue', title: 'Real venue', description: 'real', location: 'Le Marais, Paris' },
    ]);
    expect((await partnerVenues(db, 'Paris')).map((p) => p.name)).toEqual(['Real venue']);
    expect((await partnerVenues(db, 'Paris', true)).map((p) => p.name)).toEqual(['Demo venue']);
    let searched = false;
    const searching = { complete: async () => say('x'), search: async () => { searched = true; return { content: '[]', citations: [] }; } } as unknown as Parameters<typeof findPlaces>[1];
    const demo = await findPlaces(db, searching, { type: 'coffee', area: 'Paris', timezone: 'Europe/Paris', demo: true });
    expect(demo.places.map((p) => p.name)).toEqual(['Demo venue']);
    expect(searched).toBe(false);
  });
});
