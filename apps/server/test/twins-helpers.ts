import type { Db } from '../src/db/client.ts';
import { contacts, ipersons, users, wallets } from '../src/db/schema.ts';
import { refreshIdentifiers } from '../src/twins/identifiers.ts';

/** A user with (by default) a twin, a verified WhatsApp number and a proven email. */
export async function person(db: Db, opts: {
  name: string; email?: string; phone?: string | null; emailVerified?: boolean; twin?: string | null; avatar?: string | null; timezone?: string;
}) {
  const email = opts.email ?? `${opts.name.toLowerCase()}@example.com`;
  const [user] = await db.insert(users).values({
    email, name: opts.name, locale: 'en', timezone: opts.timezone ?? 'Africa/Tunis', phoneE164: opts.phone === undefined ? null : opts.phone,
    phoneCountry: opts.phone ? 'TN' : null, verifiedAt: opts.phone ? new Date() : null,
    emailVerifiedAt: opts.emailVerified === false ? null : new Date(), onboardedAt: new Date(), aiCreditMicros: 5_000_000,
  }).returning();
  const twinName = opts.twin === undefined ? `i-${opts.name}` : opts.twin;
  const [ip] = twinName ? await db.insert(ipersons).values({ userId: user!.id, displayName: twinName, avatarUrl: opts.avatar ?? null }).returning() : [];
  if (ip) await db.insert(wallets).values({ ipersonId: ip.id, balanceCents: 0, currency: 'TND' });
  await refreshIdentifiers(db, user!.id);
  return { user: user!, iperson: ip };
}

export async function addContact(db: Db, userId: string, c: { name: string; emails?: string[]; phones?: string[]; relationship?: string }) {
  const [row] = await db.insert(contacts).values({
    userId, key: c.emails?.[0] ?? `name:${c.name.toLowerCase()}`, name: c.name, emails: c.emails ?? [], phones: c.phones ?? [],
    relationship: c.relationship ?? null, inAddressBook: true,
  }).returning();
  return row!;
}
