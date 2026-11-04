import { createHash } from 'node:crypto';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { upsertFact } from '../agent/memory.ts';
import { hasCredit, meteredLlm } from '../billing/credits.ts';
import { config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { bookings, calendarEvents, connections, connectors, contacts, insights, ipersons, mailSeen, profileFacts, purchases, userServices, users } from '../db/schema.ts';
import type { AppDeps } from '../http/deps.ts';
import { decrypt, encrypt } from '../lib/crypto.ts';
import { extractEmail, type Extracted } from './extract.ts';
import { computeInsights, type BookingRow, type PurchaseRow } from './insights.ts';
import { importAddressBook, importCalendar, learnPeopleFromMail } from './people.ts';
import { matchContacts } from '../twins/matching.ts';
import { gmailApi, graphApi, tokenRequest, type MailApi, type Provider } from './providers.ts';

// Mailbox sync (addendum 2, M2): only activated services' senders, only inside the window, provider-
// side filtering, raw emails discarded right after extraction, everything metered to AI credit.

export const INITIAL_MAX = 300;
export const INCREMENTAL_MAX = 50;
/** Rough Muse Spark cost per email (≈2.5k in + 300 out tokens), before the platform fee. */
export const EST_COST_PER_EMAIL = 0.0045;

export interface MailConfig {
  provider: Provider; email: string; scopes: string; windowMonths: 1 | 2 | 3;
  lastSyncAt?: string; status?: 'idle' | 'syncing' | 'error' | 'needs_reconnect';
  progress?: { done: number; total: number; sources: string[] }; error?: string;
  /** Opt-in: also learn who the user knows from their personal mail (addresses, subjects, previews). */
  lifeScan?: boolean; lifeScanAt?: string;
  /** Separate opt-ins (jury §4), each asking for its permission only when switched on. */
  importContacts?: boolean; importCalendar?: boolean;
  /** What the last sync imported: people known, address-book contacts, calendar events. */
  counts?: { people?: number; contacts?: number; events?: number };
}

/** Whether the stored grant covers the address book / calendar (older connections only had mail). */
export function grants(cfg: Pick<MailConfig, 'scopes'>, what: 'contacts' | 'calendar') {
  const s = cfg.scopes.toLowerCase();
  return what === 'contacts' ? /contacts\.read/.test(s) : /calendars?\.read/.test(s);
}

/** The life scan re-reads people at most once a day (or when asked). */
const LIFE_SCAN_EVERY_MS = 24 * 3_600_000;
/** Calendar import range around today. */
export const CALENDAR_PAST_DAYS = 30;
export const CALENDAR_AHEAD_DAYS = 90;

/** Turns a stored connection into a mail client (refreshing the access token). Injectable for tests. */
export type MailClientFactory = (provider: Provider, refreshToken: string) => Promise<{ api: MailApi; refreshToken?: string }>;
export const realMailClient: MailClientFactory = async (provider, refreshToken) => {
  const t = await tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: refreshToken });
  return { api: provider === 'microsoft' ? graphApi(t.access_token) : gmailApi(t.access_token), refreshToken: t.refresh_token };
};

export const windowStart = (months: number, now = new Date()) => new Date(now.getTime() - months * 30 * 86_400_000);
const hash = (connectionId: string, id: string) => createHash('sha256').update(`${connectionId}:${id}`).digest('hex');

/** Senders to read: the mail-type services this user activated in the Store. */
export async function activeSenders(db: Db, userId: string) {
  const rows = await db.select({ id: connectors.id, name: connectors.name, domains: connectors.senderDomains })
    .from(userServices).innerJoin(connectors, eq(connectors.id, userServices.connectorId))
    .where(and(eq(userServices.userId, userId), eq(connectors.type, 'mail')));
  return rows.map((r) => ({ id: r.id, name: r.name, domains: r.domains as string[] })).filter((r) => r.domains.length);
}

async function loadConnection(db: Db, connectionId: string) {
  const [row] = await db.select({ c: connections, userId: ipersons.userId }).from(connections)
    .innerJoin(ipersons, eq(ipersons.id, connections.ipersonId)).where(eq(connections.id, connectionId));
  return row;
}

const setConfig = (db: Db, id: string, patch: Partial<MailConfig>) =>
  db.update(connections).set({ config: sql`${connections.config} || ${JSON.stringify(patch)}::jsonb` }).where(eq(connections.id, id));

async function client(deps: AppDeps, c: typeof connections.$inferSelect) {
  const cfg = c.config as MailConfig;
  const factory = deps.mail ?? realMailClient;
  const { api, refreshToken } = await factory(cfg.provider, decrypt(c.tokenEnc!));
  if (refreshToken) await deps.db.update(connections).set({ tokenEnc: encrypt(refreshToken) }).where(eq(connections.id, c.id));
  return api;
}

/** How many emails the first sync would read, and roughly what it costs (shown before syncing). */
export async function estimate(deps: AppDeps, connectionId: string) {
  const row = await loadConnection(deps.db, connectionId);
  if (!row) throw new Error('not found');
  const cfg = row.c.config as MailConfig;
  const senders = await activeSenders(deps.db, row.userId);
  if (!senders.length) return { emails: 0, cost_usd: 0, sources: [] };
  const api = await client(deps, row.c);
  const list = await api.list(senders.flatMap((s) => s.domains), windowStart(cfg.windowMonths), INITIAL_MAX);
  const usd = list.length * EST_COST_PER_EMAIL * (1 + config.AI_PLATFORM_FEE_RATIO);
  return { emails: list.length, cost_usd: Math.round(usd * 100) / 100, sources: senders.map((s) => s.name) };
}

export async function syncMailbox(deps: AppDeps, connectionId: string, opts: { initial?: boolean; people?: boolean } = {}) {
  const { db } = deps;
  const row = await loadConnection(db, connectionId);
  if (!row?.c.tokenEnc) return { read: 0 };
  const { c, userId } = row;
  const cfg = c.config as MailConfig;
  const senders = await activeSenders(db, userId);
  const extras = cfg.lifeScan || cfg.importContacts || cfg.importCalendar;
  if (!senders.length && !extras) return { read: 0 };
  if (deps.billing && !(await hasCredit(db, userId))) {
    await setConfig(db, c.id, { status: 'error', error: 'no_credit' });
    return { read: 0 };
  }
  const domains = senders.flatMap((s) => s.domains);
  const since = windowStart(cfg.windowMonths);
  let api: MailApi;
  try {
    api = await client(deps, c);
  } catch (err) {
    await setConfig(db, c.id, { status: 'needs_reconnect', error: String((err as Error).message).slice(0, 120) });
    await db.update(userServices).set({ health: 'needs_attention', statusLine: 'Reconnect your mailbox' })
      .where(and(eq(userServices.userId, userId), inArray(userServices.connectorId, senders.map((s) => s.id))));
    throw err;
  }

  const listed = senders.length ? await api.list(domains, since, opts.initial ? INITIAL_MAX : INCREMENTAL_MAX) : [];
  const seen = new Set((await db.select({ h: mailSeen.hash }).from(mailSeen).where(eq(mailSeen.connectionId, c.id))).map((r) => r.h));
  const todo = listed.filter((m) => !seen.has(hash(c.id, m.id)));
  const llm = deps.billing ? meteredLlm(deps.llm, db, userId, config.META_LLM_MODEL) : deps.llm;
  const sourceOf = (from: string) => senders.find((s) => s.domains.some((d) => from.toLowerCase().includes(d)));
  await setConfig(db, c.id, { status: 'syncing', progress: { done: 0, total: todo.length, sources: senders.map((s) => s.name) } });

  let done = 0;
  for (const meta of todo) {
    try {
      const mail = await api.get(meta.id);
      // Belt and braces: the provider query already filtered, but never process anything else.
      if (mail.receivedAt < since || !sourceOf(mail.from)) continue;
      const source = sourceOf(mail.from)!;
      const x = await extractEmail(llm, mail);
      await storeExtracted(db, userId, { id: source.id, name: source.name }, c.id, x, mail.receivedAt);
      // The email itself is dropped here; only its id hash stays, so it isn't read again.
      await db.insert(mailSeen).values({ connectionId: c.id, hash: hash(c.id, meta.id), receivedAt: mail.receivedAt }).onConflictDoNothing();
    } catch (err) {
      if ((err as { status?: number }).status === 401) throw err;
    }
    done++;
    if (done % 5 === 0 || done === todo.length) await setConfig(db, c.id, { progress: { done, total: todo.length, sources: senders.map((s) => s.name) } });
  }

  const counts = await syncLife(deps, { c, cfg, userId, api, llm, since, force: opts.initial || opts.people });
  if (counts?.contacts || counts?.people) await matchContacts(db, userId).catch(() => {}); // who of them has an i-person

  await setConfig(db, c.id, { status: 'idle', lastSyncAt: new Date().toISOString(), error: undefined, ...(counts ? { counts: { ...cfg.counts, ...counts } } : {}) });
  await refreshStatusLines(db, userId, senders);
  const found = await refreshInsights(deps, userId);
  // The first sync ends with the twin presenting what it learned (M4 UI): top 3, by voice, smiling.
  if (opts.initial && found.length) {
    const top = [...found].filter((i) => i.kind !== 'upcoming').sort((a, b) => b.confidence - a.confidence).slice(0, 3);
    const pick = top.length ? top : found.slice(0, 3);
    deps.bus.publish(c.ipersonId, { type: 'agent.text', final: true, mood: 'happy', text: `I read your ${senders.map((s) => s.name).join(' and ')} emails. ${pick.map((i) => `${i.title}.`).join(' ')}` });
  }
  return { read: done, insights: found.length };
}

/** Address book, calendar and (opt-in) people from mail. Each part fails on its own without stopping the others. */
async function syncLife(deps: AppDeps, a: { c: typeof connections.$inferSelect; cfg: MailConfig; userId: string; api: MailApi; llm: AppDeps['llm']; since: Date; force?: boolean }) {
  const { db } = deps;
  const counts: NonNullable<MailConfig['counts']> = {};
  const log = (what: string) => (err: unknown) => { console.warn(`mailbox ${what} failed`, (err as Error).message); return undefined; };
  if (a.cfg.importContacts && grants(a.cfg, 'contacts') && a.api.addressBook) {
    const book = await a.api.addressBook().catch(log('address book'));
    if (book) counts.contacts = await importAddressBook(db, a.userId, a.c.id, book);
  }
  if (a.cfg.importCalendar && grants(a.cfg, 'calendar') && a.api.calendar) {
    const now = Date.now();
    const events = await a.api.calendar(new Date(now - CALENDAR_PAST_DAYS * 86_400_000), new Date(now + CALENDAR_AHEAD_DAYS * 86_400_000)).catch(log('calendar'));
    if (events) counts.events = await importCalendar(db, a.c.ipersonId, a.c.id, a.cfg.provider === 'microsoft' ? 'outlook' : 'google', events);
  }
  const due = !a.cfg.lifeScanAt || Date.now() - new Date(a.cfg.lifeScanAt).getTime() > LIFE_SCAN_EVERY_MS;
  if (a.cfg.lifeScan && (a.force || due)) {
    const [u] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, a.userId));
    const n = await learnPeopleFromMail(db, a.llm, {
      userId: a.userId, ipersonId: a.c.ipersonId, userName: u?.name ?? 'the user', connectionId: a.c.id,
      self: [a.cfg.email, u?.email ?? ''].filter(Boolean), api: a.api, since: a.since,
    }).catch(log('people'));
    if (n != null) {
      await setConfig(db, a.c.id, { lifeScanAt: new Date().toISOString() });
      const [k] = await db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(and(eq(contacts.userId, a.userId), sql`${contacts.relationship} is not null`));
      counts.people = k?.n ?? n;
    }
  }
  return Object.keys(counts).length ? counts : undefined;
}

/** Upserts extracted purchases/bookings (dedup by provider reference). Returns how many rows. */
export async function storeExtracted(db: Db, userId: string, source: { id: string; name: string }, connectionId: string | null, x: Extracted, receivedAt: Date) {
  for (const p of x.purchases) {
    await db.insert(purchases).values({
      userId, connectorId: source.id, connectionId, providerRef: p.order_ref, merchant: source.name, title: p.title,
      itemRef: p.item_ref ?? null, category: p.category ?? null, quantity: p.quantity ?? 1,
      amountCents: p.amount != null ? Math.round(p.amount * 100) : null, currency: p.currency?.toUpperCase() ?? null,
      orderedAt: validDate(p.ordered_at) ?? receivedAt, deliveryAt: validDate(p.delivery_at),
    }).onConflictDoUpdate({ target: [purchases.userId, purchases.providerRef, purchases.title], set: { deliveryAt: validDate(p.delivery_at) } });
  }
  for (const b of x.bookings) {
    const values = {
      userId, connectorId: source.id, connectionId, providerRef: b.booking_ref, kind: b.kind, title: b.title,
      city: b.city ?? null, country: b.country ?? null, routeFrom: b.route_from ?? null, routeTo: b.route_to ?? null,
      stars: b.stars ?? null, nights: b.nights ?? null, startAt: validDate(b.start_at), endAt: validDate(b.end_at),
      bookedAt: receivedAt, freeCancellation: b.free_cancellation ?? null,
      amountCents: b.amount != null ? Math.round(b.amount * 100) : null, currency: b.currency?.toUpperCase() ?? null,
    };
    await db.insert(bookings).values(values).onConflictDoUpdate({ target: [bookings.userId, bookings.providerRef], set: { startAt: values.startAt, endAt: values.endAt, nights: values.nights } });
  }
  return x.purchases.length + x.bookings.length;
}

const validDate = (s?: string | null) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "12 orders learned · last import 2 days ago" on each active service. */
async function refreshStatusLines(db: Db, userId: string, senders: { id: string; name: string }[]) {
  for (const s of senders) {
    const [p] = await db.select({ n: sql<number>`count(distinct ${purchases.providerRef})::int` }).from(purchases).where(and(eq(purchases.userId, userId), eq(purchases.connectorId, s.id)));
    const [b] = await db.select({ n: sql<number>`count(*)::int` }).from(bookings).where(and(eq(bookings.userId, userId), eq(bookings.connectorId, s.id)));
    const line = b!.n ? `${b!.n} booking${b!.n === 1 ? '' : 's'} learned` : p!.n ? `${p!.n} order${p!.n === 1 ? '' : 's'} learned` : 'Nothing found yet';
    await db.update(userServices).set({ health: 'ok', statusLine: `${line} · updated just now`, updatedAt: new Date() })
      .where(and(eq(userServices.userId, userId), eq(userServices.connectorId, s.id)));
  }
}

/** Recompute insights; confident ones also become profile facts (source: mailbox). */
export async function refreshInsights(deps: AppDeps, userId: string) {
  const { db } = deps;
  const ps = (await db.select().from(purchases).where(eq(purchases.userId, userId))) as PurchaseRow[];
  const bs = await db.select({ b: bookings, source: connectors.name }).from(bookings).leftJoin(connectors, eq(connectors.id, bookings.connectorId)).where(eq(bookings.userId, userId));
  const found = computeInsights(ps, bs.map((r) => ({ ...r.b, source: r.source ?? '' })) as BookingRow[], new Date());
  const [ip] = await db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.userId, userId));
  for (const i of found) {
    await db.insert(insights).values({ userId, kind: i.kind, key: i.key, title: i.title, body: i.body, data: { ...i.data, group: i.group }, evidenceRefs: i.evidence, confidence: i.confidence, validUntil: i.validUntil })
      .onConflictDoUpdate({ target: [insights.userId, insights.key], set: { title: i.title, body: i.body, data: { ...i.data, group: i.group }, evidenceRefs: i.evidence, confidence: i.confidence, validUntil: i.validUntil ?? null } });
    if (ip && i.confidence >= 0.75 && i.kind !== 'upcoming') {
      await upsertFact(db, ip.id, { category: i.kind === 'reorder' || i.kind === 'travel_route' ? 'routine' : 'preference', key: `mailbox_${i.key.replace(/[^a-z0-9]+/gi, '_')}`, value: `${i.title}. ${i.body}`, source: 'mailbox', confidence: i.confidence });
    }
  }
  return found;
}

/** Shrinking the window deletes what falls outside it (M2.1). */
export async function applyWindow(db: Db, connectionId: string, months: 1 | 2 | 3) {
  const since = windowStart(months);
  await db.delete(purchases).where(and(eq(purchases.connectionId, connectionId), lt(purchases.orderedAt, since)));
  await db.delete(bookings).where(and(eq(bookings.connectionId, connectionId), lt(bookings.bookedAt, since)));
  await db.delete(mailSeen).where(and(eq(mailSeen.connectionId, connectionId), lt(mailSeen.receivedAt, since)));
  await setConfig(db, connectionId, { windowMonths: months });
}

/** Disconnect: drop tokens; on request also everything learned from this mailbox (M1.4). */
export async function disconnectMailbox(deps: AppDeps, connectionId: string, purge: boolean) {
  const { db } = deps;
  const row = await loadConnection(db, connectionId);
  if (!row) return;
  const cfg = row.c.config as MailConfig;
  if (cfg.provider === 'google' && row.c.tokenEnc) {
    // Best effort: tell Google to revoke the token too.
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(row.c.tokenEnc))}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }
  if (purge) {
    const learnedP = await db.delete(purchases).where(eq(purchases.connectionId, connectionId)).returning({ id: purchases.id });
    const learnedB = await db.delete(bookings).where(eq(bookings.connectionId, connectionId)).returning({ id: bookings.id });
    const ids = new Set([...learnedP, ...learnedB].map((r) => r.id));
    const all = await db.select().from(insights).where(eq(insights.userId, row.userId));
    const derived = all.filter((i) => (i.evidenceRefs as string[]).some((e) => ids.has(e)));
    if (derived.length) await db.delete(insights).where(inArray(insights.id, derived.map((i) => i.id)));
    await db.delete(profileFacts).where(and(eq(profileFacts.ipersonId, row.c.ipersonId), eq(profileFacts.source, 'mailbox')));
  }
  // People and imported calendar events always go with the mailbox they came from.
  await db.delete(contacts).where(eq(contacts.connectionId, connectionId));
  await db.delete(calendarEvents).where(eq(calendarEvents.connectionId, connectionId));
  await db.delete(connections).where(eq(connections.id, connectionId));
  if (purge) await refreshInsights(deps, row.userId);
}
