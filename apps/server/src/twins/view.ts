import type { ContactStatus, ContactView } from '@ipersons/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { contacts, ipersons, twinConnections } from '../db/schema.ts';
import { visibleMatch } from './matching.ts';

// What the browser sees for a contact (§1.5): the contact's own name from the address book, and for a
// contact on i-persons only the other twin's name, a thumbnail served through the contact, and the
// connection status. Never the other account's id, email or phone.

type ContactRow = typeof contacts.$inferSelect;
type ConnRow = typeof twinConnections.$inferSelect;

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]!.toUpperCase()).join('') || '?';

/** The other user's status relative to `me`, from the pair's connection row. */
export function connectionStatus(me: string, conn: ConnRow | undefined): ContactStatus {
  if (!conn) return 'on_iperson';
  if (conn.status === 'active') return 'connected';
  if (conn.status === 'pending') return conn.requesterId === me ? 'requested' : 'incoming';
  if (conn.status === 'blocked') return conn.blockedBy === me ? 'blocked' : 'not_yet';
  return 'on_iperson'; // declined or revoked: may ask again later
}

export interface InviteInfo { channel: 'email' | 'whatsapp'; at: Date; reminded: boolean }

export const REMIND_AFTER_MS = 7 * 86_400_000;

/**
 * Views for the owner's contacts. Matches are re-checked live against the other side's current
 * settings (discoverability, blocks), so a change there applies at once, not only at the next sync.
 */
export async function contactViews(db: Db, userId: string, rows: ContactRow[], invites: Map<string, InviteInfo> = new Map(), now = new Date()): Promise<ContactView[]> {
  const matched = [...new Set(rows.map((r) => r.matchedUserId).filter((x): x is string => Boolean(x)))];
  const conns = matched.length ? await db.select().from(twinConnections).where(or(
    and(eq(twinConnections.requesterId, userId), inArray(twinConnections.recipientId, matched)),
    and(eq(twinConnections.recipientId, userId), inArray(twinConnections.requesterId, matched)),
  )) : [];
  const connOf = (other: string) => conns.find((c) => c.requesterId === other || c.recipientId === other);
  const twins = matched.length ? await db.select({ userId: ipersons.userId, name: ipersons.displayName, avatar: ipersons.avatarUrl }).from(ipersons).where(inArray(ipersons.userId, matched)) : [];
  const visible = new Map<string, boolean>();
  for (const m of matched) visible.set(m, await visibleMatch(db, userId, m, connOf(m) ?? null));

  return rows.map((r) => {
    const emails = (r.emails as string[]) ?? [];
    const phones = (r.phones as string[]) ?? [];
    const base = {
      id: r.id, name: r.name, initials: initials(r.name), relationship: r.relationship, label: r.label, notes: r.notes,
      channels: { email: emails.length > 0, whatsapp: phones.length > 0 },
    };
    const other = r.hasIperson && r.matchedUserId && visible.get(r.matchedUserId) ? r.matchedUserId : null;
    if (other) {
      const conn = connOf(other);
      const status = connectionStatus(userId, conn);
      if (status !== 'not_yet') {
        const twin = twins.find((t) => t.userId === other);
        return {
          ...base, status,
          twin: { name: twin?.name ?? 'i-person', avatar: twin?.avatar ? `/api/contacts/${r.id}/twin-avatar` : null },
          ...(conn && status !== 'on_iperson' ? { connection_id: conn.id } : {}),
        };
      }
    }
    const inv = invites.get(r.id);
    if (inv) {
      return { ...base, status: 'invited' as const, invited: { channel: inv.channel, at: inv.at.toISOString(), can_remind: !inv.reminded && now.getTime() - inv.at.getTime() >= REMIND_AFTER_MS } };
    }
    return { ...base, status: 'not_yet' as const };
  });
}
