import { createHash, createHmac } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { connections, ipersons, userIdentifiers, users } from '../db/schema.ts';

// §1 Matching, privacy first: only VERIFIED identifiers of i-persons users are stored, and only as keyed
// hashes. A contact's emails/phones are hashed the same way and looked up; nobody learns which one matched.

export type IdentifierKind = 'email' | 'phone';

const key = () => config.IDENTIFIER_HMAC_KEY
  ?? createHash('sha256').update(`identifiers|${config.APP_ENCRYPTION_KEY ?? config.JWT_SECRET ?? 'dev-only-secret'}`).digest('hex');

export const normaliseEmail = (e: string): string | null => {
  const v = e.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
};

/** E.164 or null. Numbers without a country code are read in the owner's country. */
export function normalisePhone(raw: string, defaultCountry?: string | null): string | null {
  const p = parsePhoneNumberFromString(raw.trim(), (defaultCountry ?? undefined) as CountryCode | undefined);
  return p?.isValid() ? p.number : null;
}

export function identifierHmac(kind: IdentifierKind, value: string): string {
  return createHmac('sha256', key()).update(`${kind}:${value}`).digest('hex');
}

/** The user's verified identifiers, in plain form (never stored): WhatsApp number, proven account email, connected mailboxes. */
export async function verifiedIdentifiers(db: Db, userId: string): Promise<{ kind: IdentifierKind; value: string }[]> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) return [];
  const out: { kind: IdentifierKind; value: string }[] = [];
  if (u.phoneE164) out.push({ kind: 'phone', value: u.phoneE164 });
  if (u.emailVerifiedAt) out.push({ kind: 'email', value: u.email.toLowerCase() });
  // A mailbox connected through OAuth proves its address too.
  const boxes = await db.select({ config: connections.config }).from(connections).innerJoin(ipersons, eq(ipersons.id, connections.ipersonId))
    .where(and(eq(ipersons.userId, userId), or(eq(connections.kind, 'mail_microsoft'), eq(connections.kind, 'mail_google'))));
  for (const b of boxes) {
    const email = normaliseEmail(String((b.config as { email?: string }).email ?? ''));
    if (email && !out.some((o) => o.kind === 'email' && o.value === email)) out.push({ kind: 'email', value: email });
  }
  return out;
}

/** Rewrites the user's identifier hashes from what is verified right now (call after any verification change). */
export async function refreshIdentifiers(db: Db, userId: string): Promise<number> {
  const ids = await verifiedIdentifiers(db, userId);
  await db.transaction(async (tx) => {
    await tx.delete(userIdentifiers).where(eq(userIdentifiers.userId, userId));
    for (const i of ids) {
      await tx.insert(userIdentifiers).values({ kind: i.kind, hmac: identifierHmac(i.kind, i.value), userId })
        .onConflictDoUpdate({ target: [userIdentifiers.kind, userIdentifiers.hmac], set: { userId, verifiedAt: new Date() } });
    }
  });
  return ids.length;
}

/** hmac → user id, for the given hashes (excluding `exceptUserId`). */
export async function lookupHashes(db: Db, hashes: string[], exceptUserId: string): Promise<Map<string, string>> {
  if (!hashes.length) return new Map();
  const rows = await db.select().from(userIdentifiers).where(inArray(userIdentifiers.hmac, [...new Set(hashes)]));
  return new Map(rows.filter((r) => r.userId !== exceptUserId).map((r) => [r.hmac, r.userId]));
}
