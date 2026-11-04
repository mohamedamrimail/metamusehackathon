import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaSender } from '../src/channels/whatsapp-client.ts';
import { actions, contacts, invites, users } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { acceptInvite, payReferral, recordWhatsappInvite, sendEmailInvite } from '../src/twins/invites.ts';
import { clearTwinSettingsCache, saveTwinSettings } from '../src/twins/settings.ts';
import { geoFor, reset, testDb, testGeo } from './helpers.ts';
import { addContact, person } from './twins-helpers.ts';

const { db, pool } = testDb();
let app: FastifyInstance;
const wa = { sendText: vi.fn(), sendButtons: vi.fn(), sendTemplate: vi.fn(), sendImage: vi.fn(), downloadMedia: vi.fn() } satisfies WaSender;

beforeEach(async () => {
  await reset(db);
  await db.execute('truncate invite_suppressions');
  clearTwinSettingsCache();
  geoFor.country = 'TN';
  vi.clearAllMocks();
  await app?.close();
  app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true, wa }));
  await app.ready();
});
afterAll(async () => {
  geoFor.country = 'TN';
  await app.close();
  await pool.end();
});

const h = (userId: string) => ({ cookie: `ip_session=${app.jwt.sign({ sub: userId })}` });
const DAY = 86_400_000;

describe('§3 invites', () => {
  it('email: tapping Send is the approval; logged in Activity; the contact shows as Invited', async () => {
    const me = await person(db, { name: 'Hana Amri', phone: '+21655000001' });
    const c = await addContact(db, me.user.id, { name: 'Sami', emails: ['sami@x.tn'] });
    const pre = (await app.inject({ method: 'GET', url: `/api/contacts/${c.id}/invite`, headers: h(me.user.id) })).json();
    expect(pre).toMatchObject({ emails: ['sami@x.tn'], text: expect.stringMatching(/^Hana invites you to i-persons, a digital twin that plans with you and never acts without your yes/) });
    const res = await app.inject({ method: 'POST', url: `/api/contacts/${c.id}/invite`, headers: h(me.user.id), payload: { channel: 'email', email: 'sami@x.tn', reply_to: true } });
    expect(res.statusCode).toBe(200);
    // No SMTP in tests: the message is kept as the outbox, with the personal link and the opt-out.
    expect(res.json()).toMatchObject({ sent: true, outbox: true, text: expect.stringMatching(/\/join\/[\w-]+[\s\S]*Don't send me invites again: .*\/api\/invites\/[\w-]+\/unsubscribe/) });
    const [a] = await db.select().from(actions).where(eq(actions.tool, 'invite_contact'));
    expect(a).toMatchObject({ status: 'done', risk: 'write', summary: 'Invited Sami to i-persons by email' });
    const list = (await app.inject({ method: 'GET', url: '/api/contacts', headers: h(me.user.id) })).json();
    expect(list.contacts[0]).toMatchObject({ status: 'invited', invited: { channel: 'email', can_remind: false } });
    // Once per contact per 30 days.
    const again = await app.inject({ method: 'POST', url: `/api/contacts/${c.id}/invite`, headers: h(me.user.id), payload: { channel: 'email' } });
    expect(again.statusCode).toBe(409);
  });

  it('needs a verified WhatsApp number and counts against the email limits', async () => {
    const unverified = await person(db, { name: 'Hana', phone: null });
    const c0 = await addContact(db, unverified.user.id, { name: 'A', emails: ['a@x.tn'] });
    await expect(sendEmailInvite(db, unverified.user, c0, { email: 'a@x.tn' })).rejects.toThrow(/verified WhatsApp/);

    const me = await person(db, { name: 'Omar', phone: '+21655000002' });
    const cs = await Promise.all(['a', 'b', 'c'].map((n) => addContact(db, me.user.id, { name: n, emails: [`${n}@x.tn`] })));
    await sendEmailInvite(db, me.user, cs[0]!, { email: 'a@x.tn' });
    await sendEmailInvite(db, me.user, cs[1]!, { email: 'b@x.tn' });
    // 5 emails an hour, a first email to a new address counts double: the third new address waits.
    await expect(sendEmailInvite(db, me.user, cs[2]!, { email: 'c@x.tn' })).rejects.toThrow(/Email limit reached/);
  });

  it('one reminder, only after 7 days', async () => {
    const me = await person(db, { name: 'Hana', phone: '+21655000001' });
    const c = await addContact(db, me.user.id, { name: 'Sami', phones: ['+21655000111'] });
    const t0 = new Date();
    await recordWhatsappInvite(db, me.user, c, { now: t0 });
    await expect(recordWhatsappInvite(db, me.user, c, { remind: true, now: new Date(t0.getTime() + 3 * DAY) })).rejects.toThrow(/7 days/);
    await recordWhatsappInvite(db, me.user, c, { remind: true, now: new Date(t0.getTime() + 8 * DAY) });
    await expect(recordWhatsappInvite(db, me.user, c, { remind: true, now: new Date(t0.getTime() + 9 * DAY) })).rejects.toThrow(/already reminded/);
  });

  it('10 invites a day', async () => {
    const me = await person(db, { name: 'Hana', phone: '+21655000001' });
    for (let i = 0; i < 10; i++) await recordWhatsappInvite(db, me.user, await addContact(db, me.user.id, { name: `P${i}`, phones: [`+2165500010${i}`] }));
    const eleventh = await addContact(db, me.user.id, { name: 'P10', phones: ['+21655000200'] });
    await expect(recordWhatsappInvite(db, me.user, eleventh)).rejects.toThrow(/at most 10 invites a day/);
  });

  it('WhatsApp: returns a wa.me link with the text; never sends from the Business number', async () => {
    const me = await person(db, { name: 'Hana', phone: '+21655000001' });
    const c = await addContact(db, me.user.id, { name: 'Sami', phones: ['55 000 111'] });
    const res = await app.inject({ method: 'POST', url: `/api/contacts/${c.id}/invite`, headers: h(me.user.id), payload: { channel: 'whatsapp' } });
    const body = res.json();
    expect(body.wa_link).toMatch(/^https:\/\/wa\.me\/21655000111\?text=Hana%20invites%20you/);
    expect(decodeURIComponent(body.wa_link.split('text=')[1])).toMatch(/Join here: .*\/join\/[\w-]+$/);
    for (const fn of Object.values(wa)) expect(fn).not.toHaveBeenCalled();
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0]!.inviteStatus).toBe('whatsapp');
    // No number: the share sheet text instead.
    const noPhone = await addContact(db, me.user.id, { name: 'Lea', emails: ['lea@x.tn'] });
    const share = (await app.inject({ method: 'POST', url: `/api/contacts/${noPhone.id}/invite`, headers: h(me.user.id), payload: { channel: 'whatsapp' } })).json();
    expect(share.wa_link).toBeUndefined();
    expect(share.share_text).toMatch(/\/join\//);
  });

  it('"Don\'t send me invites again" suppresses the address for every user', async () => {
    const me = await person(db, { name: 'Hana', phone: '+21655000001' });
    const other = await person(db, { name: 'Omar', phone: '+21655000002' });
    const c = await addContact(db, me.user.id, { name: 'Sami', emails: ['sami@x.tn'] });
    const sent = await sendEmailInvite(db, me.user, c, { email: 'sami@x.tn' });
    const token = /\/api\/invites\/([\w-]+)\/unsubscribe/.exec(String(sent.text))![1]!;
    expect((await app.inject({ method: 'GET', url: `/api/invites/${token}/unsubscribe` })).body).toContain("Don't send me invites again");
    expect((await app.inject({ method: 'POST', url: `/api/invites/${token}/unsubscribe` })).statusCode).toBe(200);
    const c2 = await addContact(db, other.user.id, { name: 'Sami S', emails: ['SAMI@x.tn'] });
    await expect(sendEmailInvite(db, other.user, c2, { email: 'sami@x.tn' })).rejects.toThrow(/asked not to receive/);
  });

  it('join link: shows only the first name, links the new account, and keeps the country gate unless allowed', async () => {
    const me = await person(db, { name: 'Hana Amri', phone: '+21655000001' });
    const c = await addContact(db, me.user.id, { name: 'Sami', phones: ['+21655000111'] });
    await recordWhatsappInvite(db, me.user, c);
    const [inv] = await db.select().from(invites);
    const info = (await app.inject({ method: 'GET', url: `/api/invites/${inv!.token}` })).json();
    expect(info).toEqual({ inviter: 'Hana', valid: true, country_allowed: true, country: 'TN' });

    geoFor.country = 'FR';
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'sami@x.fr', password: 'correct horse', name: 'Sami', join_token: inv!.token } });
    expect(blocked.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/invites/${inv!.token}` })).json().country_allowed).toBe(false);
    await saveTwinSettings(db, { invitesBypassCountry: true }, 'test');
    const ok = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'sami@x.fr', password: 'correct horse', name: 'Sami', join_token: inv!.token } });
    expect(ok.statusCode).toBe(200);
    const [after] = await db.select().from(invites);
    expect(after!.acceptedUserId).toBe(ok.json().user.id);
  });

  it('referral credit: only after verification, paid once to both, capped per inviter', async () => {
    await saveTwinSettings(db, { referralCreditUsd: 1, referralMaxRewarded: 1 }, 'test');
    const me = await person(db, { name: 'Hana', phone: '+21655000001' });
    const credit = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0]!.aiCreditMicros;
    const start = await credit(me.user.id);
    const join = async (name: string, phone: string) => {
      const c = await addContact(db, me.user.id, { name, phones: [phone] });
      await recordWhatsappInvite(db, me.user, c);
      const [inv] = await db.select().from(invites).where(eq(invites.contactId, c.id));
      const invitee = await person(db, { name, phone: null });
      expect(await acceptInvite(db, inv!.token, invitee.user.id)).toBe(true);
      return invitee;
    };
    const sami = await join('Sami', '+21655000111');
    // Not verified yet: nothing.
    expect(await payReferral(db, sami.user.id)).toBeUndefined();
    await db.update(users).set({ phoneE164: '+21655000111' }).where(eq(users.id, sami.user.id));
    const samiBefore = await credit(sami.user.id);
    expect((await payReferral(db, sami.user.id))?.rewardMicros).toBe(1_000_000);
    expect(await payReferral(db, sami.user.id)).toBeUndefined(); // once
    expect(await credit(me.user.id)).toBe(start + 1_000_000);
    expect(await credit(sami.user.id)).toBe(samiBefore + 1_000_000);

    const lea = await join('Lea', '+21655000222');
    await db.update(users).set({ phoneE164: '+21655000222' }).where(eq(users.id, lea.user.id));
    expect((await payReferral(db, lea.user.id))?.rewardMicros).toBe(0); // cap reached
    expect(await credit(me.user.id)).toBe(start + 1_000_000);

    const metrics = (await app.inject({ method: 'GET', url: '/api/admin/twins', headers: h((await person(db, { name: 'Admin', email: 'admin@example.com' })).user.id) })).json();
    expect(metrics.invites).toMatchObject({ sent: 2, signed_up: 2, verified: 2, referral_credit_usd: 2, rewarded_invites: 1, by_channel: { whatsapp: { sent: 2 } } });
  });
});
