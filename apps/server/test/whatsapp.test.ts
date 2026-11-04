import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaSender } from '../src/channels/whatsapp-client.ts';
import { verifySignature } from '../src/channels/whatsapp.ts';
import { config } from '../src/config.ts';
import { actions, calendarEvents, ipersons, settings, users } from '../src/db/schema.ts';
import { approveUser } from '../src/lib/approval.ts';
import { clearRuntimeCache } from '../src/lib/settings.ts';
import type { AppDeps } from '../src/http/deps.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { reset, testDb, testGeo } from './helpers.ts';

const { db, pool } = testDb();
const SECRET = 'test-app-secret';
let app: FastifyInstance;
let deps: AppDeps;
let sent: { kind: string; to: string; body: string; buttons?: { id: string; title: string }[] }[];

const wa: WaSender = {
  sendText: async (to, body) => { sent.push({ kind: 'text', to, body }); },
  sendButtons: async (to, body, buttons) => { sent.push({ kind: 'buttons', to, body, buttons }); },
  sendImage: async (to, _image, _mime, caption) => { sent.push({ kind: 'image', to, body: caption }); },
  downloadMedia: async () => Buffer.alloc(0),
  sendTemplate: async (to, name, _lang, params) => { sent.push({ kind: 'template', to, body: `${name}: ${params.join(' | ')}` }); },
};

beforeEach(async () => {
  await reset(db);
  sent = [];
  config.WA_APP_SECRET = SECRET;
  config.WA_VERIFY_TOKEN = 'verify-me';
  await app?.close();
  deps = createDeps(db, { geo: testGeo, llm: new DemoLlm(() => new Date('2026-11-02T09:00:00Z')), wa, stt: undefined, demoMode: true });
  app = buildApp(deps);
});
afterAll(async () => { await app.close(); await pool.end(); });

const settle = () => vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 3000 });

async function inbound(message: Record<string, unknown>) {
  sent = [];
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: `wamid.${Math.random()}`, from: '21699111222', ...message }] } }] }] });
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
  const res = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, payload: body });
  expect(res.statusCode).toBe(200);
  await settle();
}

async function signUpAndLink() {
  const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'merry@example.com', password: 'correct horse', name: 'Merry' } });
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  const ip = (await app.inject({ method: 'POST', url: '/ipersons', headers: { cookie }, payload: { display_name: 'Mimi' } })).json().iperson.id;
  const { code } = (await app.inject({ method: 'POST', url: `/ipersons/${ip}/whatsapp/code`, headers: { cookie } })).json();
  await inbound({ type: 'text', text: { body: `LINK ${code}` } });
  expect(sent[0]!.body).toMatch(/^Verified!/); // no avatar yet: the image welcome comes when it's chosen
  sent.length = 0;
  return ip as string;
}

async function inboundFrom(from: string, text: string) {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: `wamid.${Math.random()}`, from, type: 'text', text: { body: text } }] } }] }] });
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
  await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, payload: body });
  await settle();
}

describe('verification (Phase 2)', () => {
  it('verifies with VERIFY before the twin exists, then welcomes with the avatar image once', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'new@example.com', password: 'correct horse', name: 'Nadia' } });
    const cookie = String(r.headers['set-cookie']).split(';')[0]!;
    const c = (await app.inject({ method: 'POST', url: '/me/whatsapp/code', headers: { cookie } })).json();
    expect(c.wa_link).toMatch(/text=VERIFY%20\d{6}$/);
    await inboundFrom('21699111333', `VERIFY ${c.code}`);
    expect(sent.at(-1)!.body).toMatch(/^Verified!/);
    const [u] = await db.select().from(users).where(eq(users.email, 'new@example.com'));
    expect(u).toMatchObject({ phoneE164: '+21699111333', phoneCountry: 'TN' });
    expect(u!.verifiedAt).toBeInstanceOf(Date);
    expect(u!.welcomedAt).toBeNull();

    // Choosing an avatar sends the welcome with the image — once.
    const ip = (await app.inject({ method: 'POST', url: '/ipersons', headers: { cookie }, payload: { display_name: 'N' } })).json().iperson.id;
    await db.update(ipersons).set({ avatarUrl: `/api/media/${ip}-missing.jpg` }).where(eq(ipersons.id, ip));
    const { sendWelcome } = await import('../src/channels/whatsapp.ts');
    expect(await sendWelcome(deps, u!.id)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ to: '21699111333', body: "Hi Nadia, I'm your i-person. Talk to me here or at i-persons.com." });
    expect(await sendWelcome(deps, u!.id)).toBe(false);
  });

  it('keeps one account per number and stops after 5 wrong codes', async () => {
    await signUpAndLink();
    const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'second@example.com', password: 'correct horse', name: 'Two' } });
    const cookie = String(r.headers['set-cookie']).split(';')[0]!;
    const { code } = (await app.inject({ method: 'POST', url: '/me/whatsapp/code', headers: { cookie } })).json();
    await inboundFrom('21699111222', `VERIFY ${code}`);
    expect(sent.at(-1)!.body).toMatch(/already verifies another/);
    expect((await db.select().from(users).where(eq(users.email, 'second@example.com')))[0]!.phoneE164).toBeNull();
    expect((await db.select().from(users).where(eq(users.email, 'merry@example.com')))[0]!.phoneE164).toBe('+21699111222');

    for (let i = 0; i < 5; i++) await inboundFrom('21699000444', 'VERIFY 000000');
    const { code: good } = (await app.inject({ method: 'POST', url: '/me/whatsapp/code', headers: { cookie } })).json();
    await inboundFrom('21699000444', `VERIFY ${good}`);
    expect(sent.at(-1)!.body).toMatch(/Too many attempts/);
  });
});

it('verifies signatures in constant time', () => {
  const body = Buffer.from('{"a":1}');
  const good = 'sha256=' + createHmac('sha256', 's').update(body).digest('hex');
  expect(verifySignature(body, good, 's')).toBe(true);
  expect(verifySignature(body, good, 'other')).toBe(false);
  expect(verifySignature(body, undefined, 's')).toBe(false);
});

describe('webhook', () => {
  it('answers the verification challenge only with the right token', async () => {
    const ok = await app.inject('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42');
    expect(ok.body).toBe('42');
    expect((await app.inject('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42')).statusCode).toBe(403);
  });

  it('rejects unsigned posts', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(401);
  });

  it('offers unknown numbers a guest twin, with consent first', async () => {
    await inbound({ type: 'text', text: { body: 'hello' } });
    expect(sent[0]).toMatchObject({ kind: 'buttons', buttons: [{ id: 'guest:agree' }, { id: 'guest:no' }] });
  });

  it('links with a code, then runs turns with Approve buttons', async () => {
    await signUpAndLink();
    const [u] = await db.select().from(users);
    expect(u!.phoneE164).toBe('+21699111222');

    await inbound({ type: 'text', text: { body: 'book yoga tuesday 6pm' } });
    await vi.waitFor(() => expect(sent.some((m) => m.kind === 'buttons')).toBe(true));
    const buttons = sent.find((m) => m.kind === 'buttons')!.buttons!;
    expect(buttons.map((b) => b.title)).toEqual(['Approve', 'Decline']);
    // One message: the question and the buttons together, with what was asked for.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/^Shall I go ahead\? Book "Yoga" on Tuesday/);
    expect(await db.select().from(calendarEvents)).toHaveLength(0);

    await inbound({ type: 'interactive', interactive: { button_reply: { id: buttons[0]!.id } } });
    expect(sent[0]!.body).toMatch(/^Done/);
    expect(await db.select().from(calendarEvents)).toHaveLength(1);
    const [a] = await db.select().from(actions);
    expect(a!.status).toBe('done');

    // Tapping the same button again does nothing twice.
    await inbound({ type: 'interactive', interactive: { button_reply: { id: buttons[0]!.id } } });
    expect(sent[0]!.body).toMatch(/already handled/);
    expect(await db.select().from(calendarEvents)).toHaveLength(1);
  });

  it('a forged token for another user does nothing', async () => {
    await signUpAndLink();
    await inbound({ type: 'interactive', interactive: { button_reply: { id: 'ok:forged-token' } } });
    expect(sent[0]!.body).toMatch(/already handled/);
    expect(await db.select().from(users).where(eq(users.phoneE164, '+21699111222'))).toHaveLength(1);
  });
});

describe('opportunity scan', () => {
  it('sends new finds once, by template, and never repeats them', async () => {
    const ip = await signUpAndLink();
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'merry@example.com', password: 'correct horse' } });
    const cookie = String(r.headers['set-cookie']).split(';')[0]!;
    await app.inject({ method: 'POST', url: `/ipersons/${ip}/facts`, headers: { cookie }, payload: { category: 'preference', key: 'travel_style', value: 'beach' } });

    sent = [];
    const first = (await app.inject({ method: 'POST', url: `/ipersons/${ip}/scan`, headers: { cookie } })).json();
    expect(first.sent).toHaveLength(2);
    expect(sent).toMatchObject([{ kind: 'template', to: '21699111222' }]);
    expect(sent[0]!.body).toContain('iperson_update');

    sent = [];
    const second = (await app.inject({ method: 'POST', url: `/ipersons/${ip}/scan`, headers: { cookie } })).json();
    expect(second.sent).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe('WhatsApp guest twins (Impact §3)', () => {
  const guestNumber = '21699111222';
  const press = (id: string) => inbound({ type: 'interactive', interactive: { button_reply: { id } } });

  it('asks for consent before anything else, then creates a guest twin and answers the first message', async () => {
    await inbound({ type: 'text', text: { body: 'Bonjour, tu peux m’aider ?' } });
    expect(await db.select().from(users)).toHaveLength(0); // nothing stored, no model call before consent
    await press('guest:agree');
    const [u] = await db.select().from(users).where(eq(users.phoneE164, `+${guestNumber}`));
    expect(u).toMatchObject({ locale: 'fr', aiCreditMicros: 1_000_000, phoneCountry: 'TN', consentVersion: expect.any(Number) });
    expect(u!.guestAt).not.toBeNull();
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2)); // welcome + the twin's answer to the first message
    expect(sent[0]!.body).toMatch(/^Welcome/);
  });

  it('says "Not now" politely and keeps the waitlist for other countries', async () => {
    await press('guest:no');
    expect(sent[0]!.body).toMatch(/No problem/);
    sent = [];
    await inboundFrom('5511999990000', 'hi');
    expect(sent.at(-1)!.body).toMatch(/waitlist/);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('limits guests to 30 messages a day and offers the web link', async () => {
    await press('guest:agree');
    config.RATE_LIMITS = true;
    try {
      for (let i = 0; i < 30; i++) await inbound({ type: 'text', text: { body: `hi ${i}` } });
      await inbound({ type: 'text', text: { body: 'one more' } });
      expect(sent.at(-1)!.body).toMatch(/today’s limit.*\/api\/auth\/magic\//);
    } finally {
      config.RATE_LIMITS = false;
    }
  });

  it('beta: a new guest waits for approval, nothing reaches the twin until then', async () => {
    await db.insert(settings).values({ key: 'runtime', value: { requireApproval: true } }).onConflictDoUpdate({ target: settings.key, set: { value: { requireApproval: true } } });
    clearRuntimeCache();
    try {
      await press('guest:agree');
      expect(sent.at(-1)!.body).toMatch(/in beta/);
      const [u] = await db.select().from(users).where(eq(users.phoneE164, `+${guestNumber}`));
      expect(u!.pendingApprovalAt).not.toBeNull();
      sent = [];
      await inbound({ type: 'text', text: { body: 'hello?' } });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toMatch(/in beta/);
      await approveUser(deps, u!.id);
      expect(sent.at(-1)!.body).toMatch(/approved/);
    } finally {
      await db.delete(settings).where(eq(settings.key, 'runtime'));
      clearRuntimeCache();
    }
  });

  it('signs a guest in on the web once with a magic link', async () => {
    await press('guest:agree');
    const [u] = await db.select().from(users).where(eq(users.phoneE164, `+${guestNumber}`));
    const { magicLink } = await import('../src/channels/guest.ts');
    const link = await magicLink(deps, u!.id);
    const path = new URL(link).pathname.replace(/^\/api/, '');
    const first = await app.inject({ url: path });
    expect(first.headers.location).toBe('/onboarding');
    expect(String(first.headers['set-cookie'])).toContain('ip_session=');
    expect((await app.inject({ url: path })).headers.location).toBe('/login?error=expired'); // single use
  });
});
