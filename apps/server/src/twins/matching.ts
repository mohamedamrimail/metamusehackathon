import { and, eq, inArray, or } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { contacts, ipersons, twinConnections, users } from '../db/schema.ts';
import { identifierHmac, lookupHashes, normaliseEmail, normalisePhone } from './identifiers.ts';

// §1: which of my contacts have an i-person. Stored per contact (has_iperson, matched_user_id, checked_at);
// matched_user_id is server-side only. Re-checked on each contact sync and nightly.

type Conn = typeof twinConnections.$inferSelect;

/** The one connection row between two users, whichever side asked. */
export async function pairConnection(db: Db, a: string, b: string): Promise<Conn | undefined> {
  const [row] = await db.select().from(twinConnections).where(or(
    and(eq(twinConnections.requesterId, a), eq(twinConnections.recipientId, b)),
    and(eq(twinConnections.requesterId, b), eq(twinConnections.recipientId, a)),
  ));
  return row;
}

/**
 * Whether `viewerId` may see that `otherId` has an i-person: the other has an active twin, isn't
 * suspended, hasn't chosen "nobody" and hasn't blocked the viewer. An existing connection the other
 * side agreed to (active, or a request they sent) stays visible whatever the discoverability setting.
 */
export async function visibleMatch(db: Db, viewerId: string, otherId: string, conn?: Conn | null): Promise<boolean> {
  const [o] = await db.select({ u: users, ip: ipersons }).from(users).innerJoin(ipersons, eq(ipersons.userId, users.id)).where(eq(users.id, otherId));
  if (!o || o.u.suspendedAt || o.ip.status !== 'active') return false;
  const c = conn === undefined ? await pairConnection(db, viewerId, otherId) : conn;
  if (c?.status === 'blocked' && c.blockedBy === otherId) return false;
  if (c && (c.status === 'active' || (c.status === 'pending' && c.requesterId === otherId))) return true;
  return o.u.discoverability !== 'nobody';
}

/** Hashes of a contact's normalised emails and phone numbers. */
export function contactHashes(c: { emails: unknown; phones: unknown }, country?: string | null): string[] {
  const emails = ((c.emails as string[]) ?? []).map(normaliseEmail).filter((e): e is string => Boolean(e));
  const phones = ((c.phones as string[]) ?? []).map((p) => normalisePhone(p, country)).filter((p): p is string => Boolean(p));
  return [...emails.map((e) => identifierHmac('email', e)), ...phones.map((p) => identifierHmac('phone', p))];
}

/** Re-checks the user's contacts (all, or the given ids). Returns how many have a visible i-person. */
export async function matchContacts(db: Db, userId: string, contactIds?: string[], now = new Date()): Promise<number> {
  const [owner] = await db.select().from(users).where(eq(users.id, userId));
  if (!owner) return 0;
  const country = owner.phoneCountry ?? owner.country ?? owner.signupCountry;
  const rows = await db.select().from(contacts).where(and(eq(contacts.userId, userId), contactIds?.length ? inArray(contacts.id, contactIds) : undefined));
  const perContact = rows.map((r) => ({ row: r, hashes: contactHashes(r, country) }));
  const found = await lookupHashes(db, perContact.flatMap((p) => p.hashes), userId);
  const visible = new Map<string, boolean>();
  let n = 0;
  for (const { row, hashes } of perContact) {
    // Deterministic: the first matching account, in hash order (several accounts can't share one identifier).
    const candidates = [...new Set(hashes.map((h) => found.get(h)).filter((u): u is string => Boolean(u)))].sort();
    let matched: string | null = null;
    for (const cand of candidates) {
      if (!visible.has(cand)) visible.set(cand, await visibleMatch(db, userId, cand));
      if (visible.get(cand)) { matched = cand; break; }
    }
    // A contact linked through an accepted invite, a connection or search (no identifier match needed) keeps its link while visible.
    if (!matched && row.matchedUserId && !candidates.length) {
      const keep = await visibleMatch(db, userId, row.matchedUserId);
      const c = keep ? await pairConnection(db, userId, row.matchedUserId) : undefined;
      if (keep && ((c && c.status !== 'declined') || row.key === `iperson:${row.matchedUserId}`)) matched = row.matchedUserId;
    }
    await db.update(contacts).set({ hasIperson: Boolean(matched), matchedUserId: matched, checkedAt: now }).where(eq(contacts.id, row.id));
    if (matched) n++;
  }
  return n;
}

/** Nightly: everyone with contacts. */
export async function matchAll(db: Db): Promise<void> {
  const owners = await db.selectDistinct({ id: contacts.userId }).from(contacts);
  for (const o of owners) await matchContacts(db, o.id);
}
