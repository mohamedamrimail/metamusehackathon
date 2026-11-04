import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { charge, hasCredit, metaCostMicros, usdToMicros } from '../src/billing/credits.ts';
import { familyGroups, profileFacts, settings, users } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { clearRuntimeCache } from '../src/lib/settings.ts';
import { metricsSummary } from '../src/lib/metrics.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { reset, testDb, testGeo } from './helpers.ts';

// Impact §4: pricing interest, gifts (manual payment) and family plans.

const { db, pool } = testDb();
let app: FastifyInstance;
beforeEach(async () => {
  await reset(db);
  await db.execute('truncate settings, admin_log');
  clearRuntimeCache();
  await app?.close();
  app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true }));
});
afterAll(async () => { await app.close(); await pool.end(); });

const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0]!;
async function person(email: string, name = 'Nour Ben Salah') {
  const cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name } }));
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return { cookie, id: u!.id };
}
const post = (url: string, cookie: string | undefined, payload: object = {}) => app.inject({ method: 'POST', url, headers: cookie ? { cookie } : {}, payload });

async function family() {
  const owner = await person('owner@example.com', 'Sami Trabelsi');
  const member = await person('grandma@example.com', 'Fatma Trabelsi');
  expect((await post('/api/me/family', owner.cookie, { name: 'Trabelsi' })).statusCode).toBe(201);
  const { token } = (await post('/api/me/family/invites', owner.cookie, { label: 'Grandma' })).json();
  expect((await post(`/api/family-invites/${token}/accept`, member.cookie)).statusCode).toBe(200);
  return { owner, member, token };
}

describe('pricing', () => {
  it('shows prices from settings and records Plus interest once per email', async () => {
    const info = (await app.inject({ url: '/api/pricing/info' })).json();
    expect(info).toMatchObject({ plus_price_usd: 9, gift_presets_usd: [5, 10, 25], family_max_members: 5, payment_available: false });
    expect((await post('/api/pricing/plus-interest', undefined, { email: 'Fan@Example.com' })).statusCode).toBe(200);
    expect((await post('/api/pricing/plus-interest', undefined, { email: 'fan@example.com' })).statusCode).toBe(200);
    expect((await metricsSummary(db)).plus_interest).toBe(1);
  });
});

describe('gifts', () => {
  it('waits for payment, then the code works exactly once and adds the credit', async () => {
    const r = await post('/api/gifts', undefined, { buyer_name: 'Sami', buyer_contact: 'sami@example.com', recipient_name: 'Fatma', recipient_phone: '+216 98 765 432', amount_usd: 10, message: 'For your twin' });
    expect(r.json()).toMatchObject({ status: 'pending_payment' });
    expect((await post('/api/gifts', undefined, { buyer_name: 'Sami', buyer_contact: 'sami@example.com', recipient_name: 'F', recipient_email: 'f@example.com', amount_usd: 7 })).statusCode).toBe(400); // not a preset

    const admin = await person('admin@example.com');
    const paid = (await post(`/api/admin/gifts/${r.json().id}/paid`, admin.cookie)).json();
    expect(paid.code).toMatch(/^GIFT-[0-9A-F]{8}$/);
    expect(paid.wa_link).toMatch(/^https:\/\/wa\.me\/21698765432\?text=.*GIFT-/);
    expect((await post(`/api/admin/gifts/${r.json().id}/paid`, admin.cookie)).statusCode).toBe(404); // only once

    const fatma = await person('fatma@example.com');
    const before = (await db.select().from(users).where(eq(users.id, fatma.id)))[0]!.aiCreditMicros;
    expect((await post('/api/gifts/redeem', fatma.cookie, { code: paid.code.toLowerCase() })).json()).toMatchObject({ amount_usd: 10, from: 'Sami' });
    const after = (await db.select().from(users).where(eq(users.id, fatma.id)))[0]!;
    expect(after.aiCreditMicros - before).toBe(usdToMicros(10));
    expect(after.giftAt).not.toBeNull();
    const other = await person('other@example.com');
    expect((await post('/api/gifts/redeem', other.cookie, { code: paid.code })).statusCode).toBe(404);
    expect((await post('/api/gifts/redeem', fatma.cookie, { code: paid.code })).statusCode).toBe(404);
    expect(await metricsSummary(db)).toMatchObject({ gift_requests: 1, gifts_paid: 1, gifts_redeemed: 1 });
  });

  it('redeeming approves an account that waits for beta approval', async () => {
    await db.insert(settings).values({ key: 'runtime', value: { requireApproval: true } });
    clearRuntimeCache();
    const g = (await post('/api/gifts', undefined, { buyer_name: 'Sami', buyer_contact: 'sami@example.com', recipient_name: 'Fatma', recipient_email: 'fatma@example.com', amount_usd: 5 })).json();
    const admin = await person('admin@example.com');
    const { code } = (await post(`/api/admin/gifts/${g.id}/paid`, admin.cookie)).json();
    const fatma = await person('fatma@example.com');
    expect((await app.inject({ url: '/api/me', headers: { cookie: fatma.cookie } })).json().user.pending_approval).toBe(true);
    expect((await post('/api/gifts/redeem', fatma.cookie, { code })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', headers: { cookie: fatma.cookie } })).json().user.pending_approval).toBe(false);
  });
});

describe('family plans', () => {
  it('the payer sees only first name, spend and credit, and can’t read member data', async () => {
    const { owner, member } = await family();
    const ip = (await post('/api/ipersons', member.cookie, { display_name: 'F', locale: 'en', timezone: 'Africa/Tunis' })).json().iperson;
    await db.insert(profileFacts).values({ ipersonId: ip.id, category: 'preference', key: 'drink', value: 'Secret: loves mint tea' });
    const view = (await app.inject({ url: '/api/me/family', headers: { cookie: owner.cookie } })).json().family;
    expect(view.members).toHaveLength(1);
    expect(Object.keys(view.members[0]).sort()).toEqual(['credit_usd', 'id', 'joined_at', 'name', 'spent_usd']);
    expect(view.members[0].name).toBe('Fatma');
    expect(JSON.stringify(view)).not.toMatch(/grandma@|mint tea/);
    for (const url of [`/api/ipersons/${ip.id}`, `/api/ipersons/${ip.id}/facts`, `/api/ipersons/${ip.id}/actions`]) {
      expect((await app.inject({ url, headers: { cookie: owner.cookie } })).statusCode).toBeGreaterThanOrEqual(400);
    }
    // The member sees the plan, not the other members; and can leave.
    const mine = (await app.inject({ url: '/api/me/family', headers: { cookie: member.cookie } })).json().family;
    expect(mine).toEqual({ role: 'member', name: 'Trabelsi', owner: 'Sami', pool_usd: 0 });
    expect((await post('/api/me/family/leave', member.cookie)).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me/family', headers: { cookie: owner.cookie } })).json().family.members).toHaveLength(0);
  });

  it('members spend from the pool first, then their own credit', async () => {
    const { owner, member } = await family();
    const cost = metaCostMicros({ kind: 'image', model: 'x', images: 1 });
    expect(cost).toBeGreaterThan(0);
    const [g] = await db.select().from(familyGroups).where(eq(familyGroups.ownerId, owner.id));
    await db.update(familyGroups).set({ poolMicros: cost }).where(eq(familyGroups.id, g!.id));
    await db.update(users).set({ aiCreditMicros: 0 }).where(eq(users.id, member.id));
    expect(await hasCredit(db, member.id)).toBe(true); // the pool counts
    const total = await charge(db, member.id, { kind: 'image', model: 'x', images: 1 });
    expect(total).toBeGreaterThan(cost); // the platform fee on top
    expect((await db.select().from(familyGroups).where(eq(familyGroups.id, g!.id)))[0]!.poolMicros).toBe(0);
    expect((await db.select().from(users).where(eq(users.id, member.id)))[0]!.aiCreditMicros).toBe(-(total - cost));
    expect(await hasCredit(db, member.id)).toBe(false);
    // The owner's own credit is untouched by members.
    const ownerCredit = (await db.select().from(users).where(eq(users.id, owner.id)))[0]!.aiCreditMicros;
    expect(ownerCredit).toBe(usdToMicros(5));
    const view = (await app.inject({ url: '/api/me/family', headers: { cookie: owner.cookie } })).json().family;
    expect(view.members[0].spent_usd).toBeCloseTo(total / 1e6, 2);
  });

  it('invites are single-use, families have at most 5 members, and one family per person', async () => {
    const { owner, token } = await family();
    const late = await person('late@example.com');
    expect((await post(`/api/family-invites/${token}/accept`, late.cookie)).statusCode).toBe(409);
    for (let i = 0; i < 4; i++) {
      const p = await person(`m${i}@example.com`);
      const t = (await post('/api/me/family/invites', owner.cookie)).json().token;
      expect((await post(`/api/family-invites/${t}/accept`, p.cookie)).statusCode).toBe(200);
    }
    expect((await post('/api/me/family/invites', owner.cookie)).statusCode).toBe(409);
    expect((await post('/api/me/family', late.cookie, { name: 'Mine' })).statusCode).toBe(201);
    expect((await post('/api/me/family', owner.cookie, { name: 'Again' })).statusCode).toBe(409);
    expect(await metricsSummary(db)).toMatchObject({ family_groups: 2, family_members: 5 });
  });
});
