import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertFact } from '../src/agent/memory.ts';
import { actions, contacts, invites, reports, twinConnections, users } from '../src/db/schema.ts';
import type { AppDeps } from '../src/http/deps.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { connectPausedUntil, granted, requestConnection, respond, sharedPreferences, updateMyGrants } from '../src/twins/connections.ts';
import { blockFromCard } from '../src/twins/handlers.ts';
import { onPhoneVerified } from '../src/twins/hooks.ts';
import { acceptInvite, recordWhatsappInvite } from '../src/twins/invites.ts';
import { matchContacts } from '../src/twins/matching.ts';
import { clearTwinSettingsCache, saveTwinSettings } from '../src/twins/settings.ts';
import { reset, testDb, testGeo } from './helpers.ts';
import { addContact, person } from './twins-helpers.ts';

const { db, pool } = testDb();
let app: FastifyInstance;
let deps: AppDeps;

beforeEach(async () => {
  await reset(db);
  clearTwinSettingsCache();
  await app?.close();
  deps = createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true });
  app = buildApp(deps);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const h = (userId: string) => ({ cookie: `ip_session=${app.jwt.sign({ sub: userId })}` });

/** Hana and Sami, each with the other in their contacts and matched. */
async function pair() {
  const hana = await person(db, { name: 'Hana', phone: '+21655000001' });
  const sami = await person(db, { name: 'Sami', phone: '+21655000111' });
  const hanaSees = await addContact(db, hana.user.id, { name: 'Sami A', phones: ['+21655000111'], relationship: 'friend' });
  const samiSees = await addContact(db, sami.user.id, { name: 'Hana B', phones: ['+21655000001'], relationship: 'friend' });
  await matchContacts(db, hana.user.id);
  await matchContacts(db, sami.user.id);
  return { hana, sami, hanaSees, samiSees };
}
const statusOf = async (userId: string) => (await app.inject({ method: 'GET', url: '/api/contacts', headers: h(userId) })).json().contacts[0].status;

describe('§4 connecting two i-persons', () => {
  it('Connect twins: logged for the requester, an approval card for the recipient, accepted through the card', async () => {
    const { hana, sami, hanaSees } = await pair();
    const res = await app.inject({ method: 'POST', url: `/api/contacts/${hanaSees.id}/connect`, headers: h(hana.user.id) });
    expect(res.statusCode).toBe(200);
    expect(await statusOf(hana.user.id)).toBe('requested');
    expect(await statusOf(sami.user.id)).toBe('incoming');
    const [log] = await db.select().from(actions).where(and(eq(actions.ipersonId, hana.iperson!.id), eq(actions.tool, 'connect_twins')));
    expect(log).toMatchObject({ status: 'done', summary: "Asked Sami A's i-person to connect with yours" });
    const [card] = await db.select().from(actions).where(and(eq(actions.ipersonId, sami.iperson!.id), eq(actions.tool, 'twin_request')));
    expect(card).toMatchObject({ status: 'proposed', summary: 'Hana wants to connect their i-person with yours so your twins can plan meetings together.' });
    // No planning or sharing yet.
    expect(await granted(db, sami.user.id, hana.user.id, 'plan')).toBeUndefined();

    const decided = await deps.runtime.decide({ ipersonId: sami.iperson!.id, actionId: card!.id, approve: true });
    expect(decided.action.status).toBe('done');
    expect(await statusOf(hana.user.id)).toBe('connected');
    expect(await statusOf(sami.user.id)).toBe('connected');
    // Defaults: only "plan" on both sides.
    const [conn] = await db.select().from(twinConnections);
    expect(conn).toMatchObject({ status: 'active', requesterScopes: ['plan'], recipientScopes: ['plan'] });
  });

  it('decline, cancel and double requests', async () => {
    const { hana, sami, hanaSees, samiSees } = await pair();
    await app.inject({ method: 'POST', url: `/api/contacts/${hanaSees.id}/connect`, headers: h(hana.user.id) });
    expect((await app.inject({ method: 'POST', url: `/api/contacts/${hanaSees.id}/connect`, headers: h(hana.user.id) })).json().message).toMatch(/already asked/);
    expect((await app.inject({ method: 'POST', url: `/api/contacts/${samiSees.id}/connect`, headers: h(sami.user.id) })).json().message).toMatch(/accept their request/);
    const [conn] = await db.select().from(twinConnections);
    // Only the recipient answers.
    expect((await app.inject({ method: 'POST', url: `/api/twin-connections/${conn!.id}/accept`, headers: h(hana.user.id) })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/twin-connections/${conn!.id}/decline`, headers: h(sami.user.id) })).json()).toEqual({ status: 'declined' });
    // The card closed with the answer.
    const [card] = await db.select().from(actions).where(eq(actions.tool, 'twin_request'));
    expect(card!.status).toBe('rejected');
    expect(await statusOf(hana.user.id)).toBe('on_iperson');
    // Asking again reuses the one row per pair; the requester can cancel.
    await app.inject({ method: 'POST', url: `/api/contacts/${hanaSees.id}/connect`, headers: h(hana.user.id) });
    expect((await app.inject({ method: 'POST', url: `/api/twin-connections/${conn!.id}/cancel`, headers: h(hana.user.id) })).json()).toEqual({ status: 'revoked' });
    expect(await db.select().from(twinConnections)).toHaveLength(1);
  });

  it('nobody can connect to a hidden person; strangers can\'t touch a connection', async () => {
    const { hana, sami, hanaSees } = await pair();
    const eve = await person(db, { name: 'Eve' });
    await db.update(users).set({ discoverability: 'nobody' }).where(eq(users.id, sami.user.id));
    expect((await app.inject({ method: 'POST', url: `/api/contacts/${hanaSees.id}/connect`, headers: h(hana.user.id) })).statusCode).toBe(409);
    await db.update(users).set({ discoverability: 'contacts' }).where(eq(users.id, sami.user.id));
    await app.inject({ method: 'POST', url: `/api/contacts/${hanaSees.id}/connect`, headers: h(hana.user.id) });
    const [conn] = await db.select().from(twinConnections);
    for (const verb of ['accept', 'block', 'disconnect']) {
      expect((await app.inject({ method: 'POST', url: `/api/twin-connections/${conn!.id}/${verb}`, headers: h(eve.user.id) })).statusCode).toBe(404);
    }
  });

  it('scopes are per side; preferences share only the chosen facts; revoke applies at once', async () => {
    const { hana, sami } = await pair();
    const conn = await requestConnection(deps, hana.user.id, sami.user.id);
    await respond(deps, sami.user.id, conn.id, 'accept');
    const coffee = await upsertFact(db, sami.iperson!.id, { category: 'preference', key: 'coffee', value: 'Flat white, quiet cafés' });
    await upsertFact(db, sami.iperson!.id, { category: 'preference', key: 'salary', value: 'secret' });
    const hanaFact = await upsertFact(db, hana.iperson!.id, { category: 'preference', key: 'food', value: 'Vegetarian' });

    // Nothing shared without the scope, even with facts picked.
    await updateMyGrants(db, sami.user.id, conn.id, { fact_ids: [coffee.id, hanaFact.id] });
    expect(await sharedPreferences(db, sami.user.id, hana.user.id)).toEqual([]);
    await updateMyGrants(db, sami.user.id, conn.id, { scopes: ['plan', 'preferences', 'bogus'] });
    // Only Sami's own fact counts (Hana's id was dropped), and only the picked one.
    expect(await sharedPreferences(db, sami.user.id, hana.user.id)).toEqual([{ key: 'coffee', value: 'Flat white, quiet cafés' }]);
    // Sami's grants say nothing about Hana's data.
    expect(await sharedPreferences(db, hana.user.id, sami.user.id)).toEqual([]);
    expect(await granted(db, sami.user.id, hana.user.id, 'availability')).toBeUndefined();

    // Via the API the user only edits their own side.
    const viaApi = await app.inject({ method: 'PATCH', url: `/api/twin-connections/${conn.id}`, headers: h(hana.user.id), payload: { scopes: ['plan', 'availability'] } });
    expect(viaApi.json()).toEqual({ mine: ['plan', 'availability'], my_fact_ids: [] });
    expect(await granted(db, hana.user.id, sami.user.id, 'availability')).toBeTruthy();
    expect(await granted(db, sami.user.id, hana.user.id, 'availability')).toBeUndefined();

    await respond(deps, hana.user.id, conn.id, 'disconnect');
    expect(await granted(db, sami.user.id, hana.user.id, 'plan')).toBeUndefined();
    expect(await sharedPreferences(db, sami.user.id, hana.user.id)).toEqual([]);
  });

  it('block (also from the WhatsApp card button) hides me from the blocked person, and report flags it', async () => {
    const { hana, sami, hanaSees } = await pair();
    await app.inject({ method: 'POST', url: `/api/contacts/${hanaSees.id}/connect`, headers: h(hana.user.id) });
    const [card] = await db.select().from(actions).where(eq(actions.tool, 'twin_request'));
    const decided = await deps.runtime.decide({ ipersonId: sami.iperson!.id, actionId: card!.id, approve: false });
    await blockFromCard(deps, decided.action);
    const [conn] = await db.select().from(twinConnections);
    expect(conn).toMatchObject({ status: 'blocked', blockedBy: sami.user.id });
    expect(await statusOf(hana.user.id)).toBe('not_yet');
    expect(await statusOf(sami.user.id)).toBe('blocked');
    expect(await matchContacts(db, hana.user.id)).toBe(0);
    expect((await app.inject({ method: 'POST', url: `/api/twin-connections/${conn!.id}/report`, headers: h(sami.user.id), payload: { reason: 'spam requests' } })).statusCode).toBe(200);
    expect((await db.select().from(reports))[0]).toMatchObject({ ipersonId: hana.iperson!.id, reason: '[twin-to-twin] spam requests' });
    // Unblocking returns to "not connected".
    expect((await app.inject({ method: 'POST', url: `/api/twin-connections/${conn!.id}/unblock`, headers: h(sami.user.id) })).json()).toEqual({ status: 'revoked' });
  });

  it('limits: requests per day, and a 24 h pause after 3 declines from different people in a week', async () => {
    await saveTwinSettings(db, { connectRequestsPerDay: 3 }, 'test');
    const me = await person(db, { name: 'Hana', phone: '+21655000001' });
    const others = [];
    for (const [i, n] of ['Ali', 'Bea', 'Cem', 'Dan'].entries()) {
      const o = await person(db, { name: n, phone: `+2165500020${i}` });
      await addContact(db, me.user.id, { name: n, phones: [`+2165500020${i}`] });
      others.push(o);
    }
    await matchContacts(db, me.user.id);
    for (const o of others.slice(0, 3)) await requestConnection(deps, me.user.id, o.user.id);
    await expect(requestConnection(deps, me.user.id, others[3]!.user.id)).rejects.toThrow(/At most 3 connection requests a day/);
    for (const o of others.slice(0, 3)) {
      const [c] = await db.select().from(twinConnections).where(eq(twinConnections.recipientId, o.user.id));
      await respond(deps, o.user.id, c!.id, 'decline');
    }
    expect(await connectPausedUntil(db, me.user.id)).toBeInstanceOf(Date);
    await saveTwinSettings(db, { connectRequestsPerDay: 20 }, 'test');
    await expect(requestConnection(deps, me.user.id, others[3]!.user.id)).rejects.toThrow(/paused until/);
    const admin = await person(db, { name: 'Admin', email: 'admin@example.com' });
    const metrics = (await app.inject({ method: 'GET', url: '/api/admin/twins', headers: h(admin.user.id) })).json();
    expect(metrics.connections.paused_users).toEqual([expect.objectContaining({ name: 'Hana' })]);
    expect(metrics.connections.by_status).toMatchObject({ declined: 3 });
  });

  it('an invitee who verified is asked "Connect your i-person with Hana\'s?" and connected only on yes', async () => {
    const hana = await person(db, { name: 'Hana', phone: '+21655000001' });
    const c = await addContact(db, hana.user.id, { name: 'Sami', phones: ['+4915112345678'] });
    await recordWhatsappInvite(db, hana.user, c);
    const [inv] = await db.select().from(invites);
    const sami = await person(db, { name: 'Sami', phone: null });
    await acceptInvite(db, inv!.token, sami.user.id);
    await db.update(users).set({ phoneE164: '+21655000999' }).where(eq(users.id, sami.user.id));
    await onPhoneVerified(deps, sami.user.id);
    const [conn] = await db.select().from(twinConnections);
    expect(conn).toMatchObject({ status: 'pending', origin: 'invite', requesterId: hana.user.id, recipientId: sami.user.id });
    const [card] = await db.select().from(actions).where(and(eq(actions.ipersonId, sami.iperson!.id), eq(actions.tool, 'twin_request')));
    expect(card!.summary).toMatch(/^Connect your i-person with Hana's\?/);
    // The invitee has no contacts: the request shows on their Contacts page.
    const samiList = (await app.inject({ method: 'GET', url: '/api/contacts', headers: h(sami.user.id) })).json();
    expect(samiList).toMatchObject({ synced: true, requests: [{ connection_id: conn!.id, name: 'Hana', twin_name: 'i-Hana' }] });
    expect(await statusOf(hana.user.id)).toBe('requested');
    await deps.runtime.decide({ ipersonId: sami.iperson!.id, actionId: card!.id, approve: true });
    expect(await statusOf(hana.user.id)).toBe('connected');
    expect((await db.select().from(contacts).where(eq(contacts.id, c.id)))[0]!.matchedUserId).toBe(sami.user.id);
  });
});
