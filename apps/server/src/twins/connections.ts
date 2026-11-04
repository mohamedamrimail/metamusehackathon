import { TWIN_SCOPES, type TwinScope } from '@ipersons/shared';
import { and, count, eq, gte, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { actions, contacts, invites, ipersons, profileFacts, reports, twinConnections, users } from '../db/schema.ts';
import type { AppDeps } from '../http/deps.ts';
import { ipersonOf, logDone } from './activity.ts';
import { firstNameOf } from './invites.ts';
import { pairConnection, visibleMatch } from './matching.ts';
import { systemCard, TWIN_TEMPLATES, twinSays } from './notify.ts';
import { twinSettings } from './settings.ts';

// §4 Connecting two i-persons, by mutual consent. Each side grants scopes for its OWN data; the
// effective permissions toward me are what the OTHER side granted. Either side can change scopes,
// disconnect or block at any time, and that applies at once.

export type Conn = typeof twinConnections.$inferSelect;
export const CONNECT_CARD_TTL_MS = 7 * 86_400_000;
const DAY = 86_400_000;

export class ConnectionError extends Error {}

/** The scopes `userId` granted on this connection (for their own data). */
export const grantsOf = (c: Conn, userId: string): TwinScope[] =>
  ((c.requesterId === userId ? c.requesterScopes : c.recipientScopes) as TwinScope[]) ?? [];
export const factIdsOf = (c: Conn, userId: string): string[] =>
  ((c.requesterId === userId ? c.requesterFactIds : c.recipientFactIds) as string[]) ?? [];
export const otherSide = (c: Conn, userId: string) => (c.requesterId === userId ? c.recipientId : c.requesterId);

/** Active connection where `owner` granted `scope` to `other` (e.g. owner lets other's twin plan with them). */
export async function granted(db: Db, owner: string, other: string, scope: TwinScope): Promise<Conn | undefined> {
  const c = await pairConnection(db, owner, other);
  return c?.status === 'active' && grantsOf(c, owner).includes(scope) ? c : undefined;
}

/** "3 declines from different people in a week → requests paused for 24 h." Returns the pause end, if paused. */
export async function connectPausedUntil(db: Db, userId: string, now = new Date()): Promise<Date | null> {
  const declined = await db.select({ who: twinConnections.recipientId, at: twinConnections.respondedAt }).from(twinConnections)
    .where(and(eq(twinConnections.requesterId, userId), eq(twinConnections.status, 'declined'), gte(twinConnections.respondedAt, new Date(now.getTime() - 7 * DAY))));
  const people = new Map<string, Date>();
  for (const d of declined) if (d.at && (!people.has(d.who) || people.get(d.who)! < d.at)) people.set(d.who, d.at);
  if (people.size < 3) return null;
  const third = [...people.values()].sort((a, b) => a.getTime() - b.getTime())[2]!;
  const until = new Date(third.getTime() + DAY);
  return until > now ? until : null;
}

/** §7: 20 connection requests a day, the decline pause, and no double requests. null = allowed. */
async function requestRefusal(db: Db, me: string, other: string, existing: Conn | undefined, now: Date): Promise<string | null> {
  if (existing?.status === 'active') return 'Your twins are already connected.';
  if (existing?.status === 'pending') return existing.requesterId === me ? 'You already asked; waiting for their answer.' : 'They already asked to connect: accept their request instead.';
  if (existing?.status === 'blocked') return existing.blockedBy === me ? 'You blocked this i-person. Unblock it first.' : 'This person isn’t on i-persons.';
  const until = await connectPausedUntil(db, me, now);
  if (until) return `Several people declined recently, so connection requests are paused until ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
  const ip = await ipersonOf(db, me);
  const [today] = ip ? await db.select({ n: count() }).from(actions)
    .where(and(eq(actions.ipersonId, ip), eq(actions.tool, 'connect_twins'), sql`${actions.args}->>'answer' is null and ${actions.args} ? 'connection_id'`, gte(actions.createdAt, new Date(now.getTime() - DAY)))) : [{ n: 0 }];
  const { connectRequestsPerDay } = await twinSettings(db);
  if ((today?.n ?? 0) >= connectRequestsPerDay) return `At most ${connectRequestsPerDay} connection requests a day. Try again tomorrow.`;
  return null;
}

/** The same checks as requestConnection, without doing anything (for the agent tool's proposal). */
export async function connectRefusal(db: Db, me: string, other: string, now = new Date()): Promise<string | null> {
  if (me === other) return 'That’s you.';
  const existing = await pairConnection(db, me, other);
  if (!(await visibleMatch(db, me, other, existing ?? null))) return 'This person isn’t on i-persons.';
  return requestRefusal(db, me, other, existing, now);
}

const nameOf = async (db: Db, userId: string) => (await db.select({ name: users.name }).from(users).where(eq(users.id, userId)))[0]?.name ?? 'Someone';

/** "Connect twins" on a contact who is on i-persons. The tap is the requester's yes; the recipient gets a card. */
export async function requestConnection(deps: AppDeps, me: string, other: string, opts: { origin?: 'contacts' | 'invite'; contactName?: string; now?: Date } = {}): Promise<Conn> {
  const { db } = deps;
  const now = opts.now ?? new Date();
  if (me === other) throw new ConnectionError('That’s you.');
  const existing = await pairConnection(db, me, other);
  if (opts.origin !== 'invite') {
    if (!(await visibleMatch(db, me, other, existing ?? null))) throw new ConnectionError('This person isn’t on i-persons.');
    const refusal = await requestRefusal(db, me, other, existing, now);
    if (refusal) throw new ConnectionError(refusal);
  } else if (existing) {
    return existing;
  }
  const values = {
    requesterId: me, recipientId: other, status: 'pending' as const, requesterScopes: ['plan'], recipientScopes: ['plan'],
    requesterFactIds: [], recipientFactIds: [], blockedBy: null, origin: opts.origin ?? 'contacts', respondedAt: null, updatedAt: now,
  };
  const [conn] = existing
    ? await db.update(twinConnections).set(values).where(eq(twinConnections.id, existing.id)).returning()
    : await db.insert(twinConnections).values({ ...values, createdAt: now }).returning();
  const meName = firstNameOf(await nameOf(db, me));
  if (opts.origin !== 'invite') {
    await logDone(db, me, { tool: 'connect_twins', args: { connection_id: conn!.id }, summary: `Asked ${opts.contactName ?? 'a contact'}'s i-person to connect with yours` });
  }
  const card = await systemCard(deps, other, {
    kind: 'connect', args: { connection_id: conn!.id }, ttlMs: CONNECT_CARD_TTL_MS, block: true,
    summary: opts.origin === 'invite'
      ? `Connect your i-person with ${meName}'s? Your twins could then plan meetings and dinners for you both (you approve every plan).`
      : `${meName} wants to connect their i-person with yours so your twins can plan meetings together.`,
    template: { name: TWIN_TEMPLATES.connect, params: [meName] },
  });
  if (card) await db.update(twinConnections).set({ actionId: card.id }).where(eq(twinConnections.id, conn!.id));
  // The asked person sees who asks in Contacts too (not only on the card).
  if (opts.origin !== 'invite') await ensureContact(db, other, me);
  return conn!;
}

/** Closes the recipient's open card when they answered on the Contacts page instead. */
async function closeCard(db: Db, conn: Conn, status: 'done' | 'rejected' | 'expired') {
  if (!conn.actionId) return;
  await db.update(actions).set({ status, decidedAt: new Date(), result: { answered: 'contacts page' } })
    .where(and(eq(actions.id, conn.actionId), eq(actions.status, 'proposed')));
}

export async function ownConnection(db: Db, userId: string, id: string): Promise<Conn | undefined> {
  const [c] = await db.select().from(twinConnections).where(and(eq(twinConnections.id, id), or(eq(twinConnections.requesterId, userId), eq(twinConnections.recipientId, userId))));
  return c;
}

export const connectionEnded: ((deps: AppDeps, conn: Conn) => Promise<void>)[] = [];

/**
 * Answers and changes: accept / decline (recipient of a pending request), cancel (requester), disconnect
 * (either side, active), block / unblock (either side, any time).
 */
export async function respond(deps: AppDeps, me: string, id: string, verb: 'accept' | 'decline' | 'cancel' | 'disconnect' | 'block' | 'unblock', opts: { scopes?: TwinScope[]; viaCard?: boolean } = {}): Promise<Conn> {
  const { db } = deps;
  const conn = await ownConnection(db, me, id);
  if (!conn) throw new ConnectionError('not_found');
  const now = new Date();
  const other = otherSide(conn, me);
  const set = async (patch: Partial<typeof twinConnections.$inferInsert>) =>
    (await db.update(twinConnections).set({ ...patch, updatedAt: now }).where(eq(twinConnections.id, conn.id)).returning())[0]!;
  const otherName = firstNameOf(await nameOf(db, other));
  const myName = firstNameOf(await nameOf(db, me));

  if (verb === 'accept' || verb === 'decline') {
    if (conn.status !== 'pending' || conn.recipientId !== me) throw new ConnectionError('There is no request to answer.');
    if (!opts.viaCard) await closeCard(db, conn, verb === 'accept' ? 'done' : 'rejected');
    if (verb === 'decline') {
      const row = await set({ status: 'declined', respondedAt: now, actionId: null });
      if (!opts.viaCard) await logDone(db, me, { tool: 'connect_twins', args: { connection_id: conn.id, answer: 'decline' }, summary: `Declined ${otherName}'s request to connect twins` });
      return row;
    }
    const scopes = sanitizeScopes(opts.scopes ?? ['plan']);
    const row = await set({ status: 'active', respondedAt: now, recipientScopes: scopes, actionId: null });
    if (!opts.viaCard) await logDone(db, me, { tool: 'connect_twins', args: { connection_id: conn.id, answer: 'accept' }, summary: `Connected your i-person with ${otherName}'s` });
    // The inviter's contact for an invitee who joined through their link now points at them.
    await linkContacts(db, conn);
    // Connected twins are in each other's Contacts, synced address book or not.
    await ensureContact(db, me, other);
    await ensureContact(db, other, me);
    await twinSays(deps, other, `${myName} accepted: your twins are connected. Ask me to plan something with ${myName} any time.`, { whatsapp: true });
    return row;
  }
  if (verb === 'cancel') {
    if (conn.status !== 'pending' || conn.requesterId !== me) throw new ConnectionError('There is no request to cancel.');
    await closeCard(db, conn, 'expired');
    return set({ status: 'revoked', actionId: null });
  }
  if (verb === 'disconnect') {
    if (conn.status !== 'active') throw new ConnectionError('You are not connected.');
    const row = await set({ status: 'revoked' });
    await logDone(db, me, { tool: 'connect_twins', args: { connection_id: conn.id, answer: 'disconnect' }, summary: `Disconnected your i-person from ${otherName}'s` });
    for (const f of connectionEnded) await f(deps, row);
    return row;
  }
  if (verb === 'block') {
    await closeCard(db, conn, 'rejected');
    const row = await set({ status: 'blocked', blockedBy: me, actionId: null, respondedAt: now });
    await logDone(db, me, { tool: 'connect_twins', args: { connection_id: conn.id, answer: 'block' }, summary: `Blocked ${otherName}'s i-person` });
    for (const f of connectionEnded) await f(deps, row);
    return row;
  }
  // unblock: back to "not connected"; they may ask again.
  if (conn.status !== 'blocked' || conn.blockedBy !== me) throw new ConnectionError('Nothing to unblock.');
  return set({ status: 'revoked', blockedBy: null });
}

export const sanitizeScopes = (s: readonly string[]): TwinScope[] => TWIN_SCOPES.filter((x) => s.includes(x));

/** My side's scopes and the facts I share under `preferences` (only my own facts). */
export async function updateMyGrants(db: Db, me: string, id: string, patch: { scopes?: string[]; fact_ids?: string[] }): Promise<Conn> {
  const conn = await ownConnection(db, me, id);
  if (!conn || conn.status !== 'active') throw new ConnectionError('not_found');
  const mine = conn.requesterId === me;
  const set: Partial<typeof twinConnections.$inferInsert> = { updatedAt: new Date() };
  if (patch.scopes) set[mine ? 'requesterScopes' : 'recipientScopes'] = sanitizeScopes(patch.scopes);
  if (patch.fact_ids) {
    const ip = await ipersonOf(db, me);
    const own = patch.fact_ids.length && ip ? await db.select({ id: profileFacts.id }).from(profileFacts)
      .where(and(eq(profileFacts.ipersonId, ip), inArray(profileFacts.id, patch.fact_ids))) : [];
    set[mine ? 'requesterFactIds' : 'recipientFactIds'] = own.map((f) => f.id);
  }
  const [row] = await db.update(twinConnections).set(set).where(eq(twinConnections.id, conn.id)).returning();
  return row!;
}

/** Facts `owner` lets their twin share with `other` for planning (empty without the preferences scope). */
export async function sharedPreferences(db: Db, owner: string, other: string): Promise<{ key: string; value: string }[]> {
  const c = await granted(db, owner, other, 'preferences');
  const ids = c ? factIdsOf(c, owner) : [];
  if (!ids.length) return [];
  const ip = await ipersonOf(db, owner);
  return ip ? db.select({ key: profileFacts.key, value: profileFacts.value }).from(profileFacts)
    .where(and(eq(profileFacts.ipersonId, ip), inArray(profileFacts.id, ids))) : [];
}

/**
 * An invitee who joined through the requester's link: the requester's contact row for them now points at
 * their account (no identifier match needed: the link went to that contact, and the invitee said yes).
 */
/**
 * Each side of a connection (or someone added from search) has the other in Contacts, linked to their i-person,
 * even without an address-book or mailbox sync. Key `iperson:<id>`: matching keeps the link while they are visible.
 */
export async function ensureContact(db: Db, ownerId: string, otherId: string, opts: { name?: string; relationship?: string | null } = {}) {
  const [has] = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.userId, ownerId), eq(contacts.matchedUserId, otherId))).limit(1);
  if (has) return has.id;
  const [o] = await db.select({ name: users.name }).from(users).where(eq(users.id, otherId));
  if (!o) return undefined;
  const [row] = await db.insert(contacts).values({
    userId: ownerId, key: `iperson:${otherId}`, name: (opts.name ?? o.name).slice(0, 80), relationship: opts.relationship ?? null,
    hasIperson: true, matchedUserId: otherId, checkedAt: new Date(),
  }).onConflictDoUpdate({ target: [contacts.userId, contacts.key], set: { hasIperson: true, matchedUserId: otherId, checkedAt: new Date() } }).returning({ id: contacts.id });
  return row?.id;
}

/** Start-up: every existing pending or active connection shows on both sides' Contacts. */
export async function backfillConnectionContacts(db: Db): Promise<void> {
  const rows = await db.select().from(twinConnections).where(inArray(twinConnections.status, ['pending', 'active']));
  for (const c of rows) {
    await ensureContact(db, c.requesterId, c.recipientId);
    await ensureContact(db, c.recipientId, c.requesterId);
  }
}

export async function linkInvitedContact(db: Db, inviterId: string, inviteeId: string) {
  const [ip] = await db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.userId, inviteeId));
  const [inv] = await db.select({ contactId: invites.contactId }).from(invites).where(and(eq(invites.inviterId, inviterId), eq(invites.acceptedUserId, inviteeId)));
  if (!ip || !inv?.contactId) return;
  await db.update(contacts).set({ hasIperson: true, matchedUserId: inviteeId, checkedAt: new Date() })
    .where(and(eq(contacts.id, inv.contactId), eq(contacts.userId, inviterId)));
}
const linkContacts = (db: Db, conn: Conn) => (conn.origin === 'invite' ? linkInvitedContact(db, conn.requesterId, conn.recipientId) : Promise.resolve());

/** Block + "Report this i-person" for admins. */
export async function reportConnection(deps: AppDeps, me: string, id: string, reason: string) {
  const conn = await ownConnection(deps.db, me, id);
  if (!conn) throw new ConnectionError('not_found');
  const other = otherSide(conn, me);
  const otherIp = await ipersonOf(deps.db, other);
  await deps.db.insert(reports).values({ ipersonId: otherIp ?? null, reason: `[twin-to-twin] ${reason}`.slice(0, 1000), reporterContact: `user:${me}` });
  if (conn.status !== 'blocked') await respond(deps, me, id, 'block');
}
