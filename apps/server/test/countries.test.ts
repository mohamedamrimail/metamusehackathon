import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { inviteCodes, users, waitlist } from '../src/db/schema.ts';
import { clearCountryCache, phoneRegion } from '../src/geo/countries.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { geoFor, reset, testDb, testGeo } from './helpers.ts';

const { db, pool } = testDb();
let app: FastifyInstance;

beforeEach(async () => {
  await reset(db);
  await db.execute('truncate settings, waitlist, invite_codes, bypass_emails, admin_log');
  clearCountryCache();
  geoFor.country = 'TN';
  await app?.close();
  app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true }));
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const register = (email: string, extra: object = {}) =>
  app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name: 'X', ...extra } });
const login = (email: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'correct horse' } });
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0]!;

async function admin() {
  geoFor.country = 'TN';
  return cookieOf(await register('admin@example.com'));
}

describe('country allowlist', () => {
  it('opens sign-up in allowed countries only; unknown counts as not allowed', async () => {
    expect((await register('tn@example.com')).statusCode).toBe(200);
    geoFor.country = 'FR';
    const fr = await register('fr@example.com');
    expect(fr.statusCode).toBe(403);
    expect(fr.json()).toEqual({ error: 'country_not_allowed', country: 'FR' });
    geoFor.country = null;
    expect((await register('unknown@example.com')).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/auth/country' })).json()).toEqual({ country: null, allowed: false });
  });

  it('lets invite codes through (counting uses, honouring expiry) and bypass emails', async () => {
    const a = await admin();
    const code = (await app.inject({ method: 'POST', url: '/api/admin/invites', headers: { cookie: a }, payload: { note: 'Hackathon judges', max_uses: 2, code: 'JUDGES-TEST' } })).json().invite.code;
    geoFor.country = 'FR';
    expect((await register('j1@example.com', { invite_code: code })).statusCode).toBe(200);
    expect((await register('j2@example.com', { invite_code: 'judges-test' })).statusCode).toBe(200);
    expect((await register('j3@example.com', { invite_code: code })).statusCode).toBe(403); // used up
    await db.insert(inviteCodes).values({ code: 'OLD', maxUses: 9, expiresAt: new Date(Date.now() - 1000) });
    expect((await register('j4@example.com', { invite_code: 'OLD' })).statusCode).toBe(403);

    await app.inject({ method: 'POST', url: '/api/admin/bypass', headers: { cookie: a }, payload: { email: 'Tester@Example.com' } });
    expect((await register('tester@example.com')).statusCode).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.email, 'j1@example.com'));
    expect(u).toMatchObject({ signupCountry: 'FR', inviteCode: 'JUDGES-TEST' });
  });

  it('a judges\' code works from any country and marks the account as a judge', async () => {
    await db.insert(inviteCodes).values([{ code: 'JUDGES-T1', kind: 'judge', maxUses: 100 }, { code: 'FRIEND-1', maxUses: 5 }]);
    geoFor.country = 'BR';
    const r = await register('judge1@example.com', { invite_code: 'judges-t1' });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.account_kind).toBe('judge');
    // From an allowed country the code is still used, so the judge is still marked.
    geoFor.country = 'TN';
    expect((await register('judge2@example.com', { invite_code: 'JUDGES-T1' })).json().user.account_kind).toBe('judge');
    // An ordinary code from an allowed country isn't needed and marks nothing.
    expect((await register('friend@example.com', { invite_code: 'FRIEND-1' })).json().user.account_kind).toBe('user');
    const [code] = await db.select().from(inviteCodes).where(eq(inviteCodes.code, 'JUDGES-T1'));
    expect(code!.uses).toBe(2);
  });

  it('admins can end a code without deleting it', async () => {
    const a = await admin();
    await db.insert(inviteCodes).values({ code: 'JUDGES-T2', kind: 'judge', maxUses: 100 });
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/invites/JUDGES-T2', headers: { cookie: a }, payload: { expires_at: new Date(Date.now() - 1000).toISOString() } });
    expect(res.statusCode).toBe(200);
    geoFor.country = 'BR';
    expect((await register('late@example.com', { invite_code: 'JUDGES-T2' })).statusCode).toBe(403);
  });

  it('leaves judges out of the metrics', async () => {
    const a = await admin();
    await db.insert(inviteCodes).values({ code: 'JUDGES-T3', kind: 'judge', maxUses: 100 });
    await register('real@example.com');
    await register('judge3@example.com', { invite_code: 'JUDGES-T3' });
    const days = (await app.inject({ url: '/api/admin/metrics/daily?days=1', headers: { cookie: a } })).json().days;
    // real@ only: the admin and the judge don't count.
    expect(days[0].signups).toBe(1);
  });

  it('applies admin changes without a restart', async () => {
    const a = await admin();
    geoFor.country = 'FR';
    expect((await register('early@example.com')).statusCode).toBe(403);
    const put = await app.inject({ method: 'PUT', url: '/api/admin/countries', headers: { cookie: a }, payload: { allowed: ['DE', 'TN', 'DK', 'US', 'FR'] } });
    expect(put.json().settings.allowed).toContain('FR');
    expect((await register('early@example.com')).statusCode).toBe(200);
    const log = (await app.inject({ url: '/api/admin/log', headers: { cookie: a } })).json().log;
    expect(log[0]).toMatchObject({ admin: 'admin@example.com', action: 'countries.update' });
  });

  it('lets every existing account sign in from anywhere; only new sign-ups are gated', async () => {
    await register('traveller@example.com');
    await register('stayer@example.com');
    await db.update(users).set({ phoneE164: '+21699111222', phoneCountry: 'TN' }).where(eq(users.email, 'traveller@example.com'));
    geoFor.country = 'JP';
    expect((await login('traveller@example.com')).statusCode).toBe(200);
    expect((await login('stayer@example.com')).statusCode).toBe(200);
    expect((await register('newcomer@example.com')).statusCode).toBe(403);
  });

  it('checks the phone region, not just the calling code', () => {
    expect(phoneRegion('+12025550123')).toBe('US');
    expect(phoneRegion('+14165550123')).toBe('CA'); // +1, but Canada: not on the allowlist
    expect(phoneRegion('+21655397779')).toBe('TN');
    expect(phoneRegion('+4915112345678')).toBe('DE');
  });

  it('waitlist share links count who joined through them; the landing line follows its toggle', async () => {
    const a = await admin();
    geoFor.country = 'FR';
    const first = (await app.inject({ method: 'POST', url: '/api/waitlist', payload: { email: 'amel@example.com', consent: true } })).json();
    const code = new URL(first.share_link).searchParams.get('wl')!;
    // Joining again returns the same link; a friend joins through it, another person without it.
    expect((await app.inject({ method: 'POST', url: '/api/waitlist', payload: { email: 'amel@example.com', consent: true } })).json().share_link).toBe(first.share_link);
    await app.inject({ method: 'POST', url: '/api/waitlist', payload: { email: 'friend@example.com', consent: true, ref: code } });
    geoFor.country = 'JP';
    await app.inject({ method: 'POST', url: '/api/waitlist', payload: { email: 'kenji@example.com', consent: true, ref: 'not-a-code' } });
    const res = await app.inject({ url: '/api/admin/waitlist/growth', headers: { cookie: a } });
    if (res.statusCode !== 200) throw new Error(res.body);
    const g = res.json();
    expect(g.totals).toEqual({ total: 3, countries: 2, from_shares: 1 });
    expect(g.by_country[0]).toMatchObject({ country: 'FR', total: 2, last_7d: 2, from_shares: 1 });
    expect((await app.inject({ url: '/api/waitlist/summary' })).json()).toEqual({ countries: null });
    await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: a }, payload: { showWaitlistLine: true } });
    expect((await app.inject({ url: '/api/waitlist/summary' })).json()).toEqual({ countries: 2 });
  });

  it('stores waitlist sign-ups only with consent, counted per country for the admin', async () => {
    geoFor.country = 'FR';
    expect((await app.inject({ method: 'POST', url: '/api/waitlist', payload: { email: 'w@example.com', consent: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/waitlist', payload: { email: 'W@example.com', name: 'Wafa', consent: true } })).json()).toMatchObject({ ok: true, country: 'FR', share_link: expect.stringMatching(/\/signup\?wl=/) });
    const [w] = await db.select().from(waitlist);
    expect(w).toMatchObject({ email: 'w@example.com', country: 'FR' });
    expect(w!.consentAt).toBeInstanceOf(Date);
    const a = await admin();
    expect((await app.inject({ url: '/api/admin/countries', headers: { cookie: a } })).json().waitlist).toEqual([{ country: 'FR', count: 1 }]);
  });

  it('keeps the admin area to admins', async () => {
    const user = cookieOf(await register('someone@example.com'));
    expect((await app.inject({ url: '/api/admin/countries', headers: { cookie: user } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/admin/countries' })).statusCode).toBe(401);
  });
});

describe('rate limits (Phase 3c)', () => {
  it('limits sign-ups per IP and logins per account', async () => {
    const { config } = await import('../src/config.ts');
    config.RATE_LIMITS = true;
    try {
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await register(`rl${i}@example.com`)).statusCode);
      expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
      expect(codes[5]).toBe(429);
      const logins = [];
      for (let i = 0; i < 11; i++) logins.push((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'rl0@example.com', password: 'wrong' } })).statusCode);
      expect(logins.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(logins[10]).toBe(429);
    } finally {
      config.RATE_LIMITS = false;
    }
  });
});

describe('admin users, settings and metrics (Phase 4a)', () => {
  it('tops up credit with a logged reason, suspends email and accounts, and applies settings at runtime', async () => {
    const a = await admin();
    const r = await register('member@example.com');
    const id = r.json().user.id as string;
    const users = (await app.inject({ url: '/api/admin/users?q=member', headers: { cookie: a } })).json().users;
    expect(users).toEqual([expect.objectContaining({ email: 'member@example.com', verified: false, credit_usd: 5, email_suspended: false })]);
    expect((await app.inject({ method: 'POST', url: `/api/admin/users/${id}/topup`, headers: { cookie: a }, payload: { amount_usd: 10 } })).statusCode).toBe(400); // reason required
    expect((await app.inject({ method: 'POST', url: `/api/admin/users/${id}/topup`, headers: { cookie: a }, payload: { amount_usd: 10, reason: 'Hackathon judge' } })).json()).toEqual({ credit_usd: 15 });
    const log = (await app.inject({ url: '/api/admin/log', headers: { cookie: a } })).json().log;
    expect(log[0]).toMatchObject({ action: 'user.topup', detail: { user: 'member@example.com', amount_usd: 10, reason: 'Hackathon judge' } });

    await app.inject({ method: 'POST', url: `/api/admin/users/${id}/suspend`, headers: { cookie: a }, payload: { what: 'account', suspended: true, reason: 'spam' } });
    expect((await login('member@example.com')).json().error).toBe('account_suspended');

    const s = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: a }, payload: { freeCreditUsd: 2, emailPerHour: 3 } });
    expect(s.json().settings).toMatchObject({ freeCreditUsd: 2, emailPerHour: 3 });
    expect((await register('later@example.com')).json().user.ai_credit_usd).toBe(2);
    await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: a }, payload: { freeCreditUsd: 5 } });
  });

  it('reports daily numbers and exports CSV', async () => {
    const a = await admin();
    await register('one@example.com');
    const days = (await app.inject({ url: '/api/admin/metrics/daily?days=3', headers: { cookie: a } })).json().days;
    expect(days).toHaveLength(3);
    expect(days.at(-1)).toMatchObject({ date: new Date().toISOString().slice(0, 10), signups: 1 }); // the admin doesn't count
    const csv = await app.inject({ url: '/api/admin/metrics/daily.csv?days=2', headers: { cookie: a } });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('date,signups,verified,avatars,turns,proposed,approved,declined,public_chats,recruiter_chats,active_users,voice_minutes,expired,handoffs,partner_requests,waitlist,partner_approved,meta_cost_usd,median_cost_per_active_user_usd,minutes_given_back,cost_per_active_user_usd');
  });
});
