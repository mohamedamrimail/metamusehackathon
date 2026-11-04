import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { partnerCredentials, partners, partnerTwins, userServices, users } from '../db/schema.ts';
import { countryAllowed, countrySettings } from '../geo/countries.ts';
import { hashPassword, verifyPassword } from '../lib/password.ts';

// Partner API core (addendum 3): credentials, pairwise pseudonymous twin ids, user consent.

export const PARTNER_SCOPES = ['offers:write', 'matches:read', 'twins:converse', 'requests:write', 'webhooks:manage'] as const;
export type PartnerScope = (typeof PARTNER_SCOPES)[number];
/** What users grant when activating a partner in the Store. */
export const USER_SCOPES = ['receive_offers', 'public_profile', 'requests'] as const;
export type UserScope = (typeof USER_SCOPES)[number];

const pseudonymSecret = () => config.APP_ENCRYPTION_KEY ?? config.JWT_SECRET ?? 'dev-only-pseudonyms';

/** `tw_` + 20 base32 chars of HMAC(user, partner): stable per partner, unlinkable across partners. */
export function twinIdFor(partnerId: string, userId: string): string {
  const h = createHmac('sha256', pseudonymSecret()).update(`${partnerId}:${userId}`).digest();
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  for (let i = 0; i < 20; i++) out += alphabet[h[i]! & 31];
  return `tw_${out}`;
}

export async function ensureTwin(db: Db, partnerId: string, userId: string): Promise<string> {
  const twinId = twinIdFor(partnerId, userId);
  await db.insert(partnerTwins).values({ partnerId, userId, twinId }).onConflictDoNothing();
  return twinId;
}

export async function userForTwin(db: Db, partnerId: string, twinId: string) {
  const [row] = await db.select().from(partnerTwins).where(and(eq(partnerTwins.partnerId, partnerId), eq(partnerTwins.twinId, twinId)));
  return row;
}

/** Scopes this user granted this partner in the Store (none if not activated or blocked). */
export async function userGrants(db: Db, partner: typeof partners.$inferSelect, userId: string): Promise<Set<string>> {
  if (!partner.connectorId) return new Set();
  const [svc] = await db.select().from(userServices).where(and(eq(userServices.userId, userId), eq(userServices.connectorId, partner.connectorId)));
  const [twin] = await db.select().from(partnerTwins).where(and(eq(partnerTwins.partnerId, partner.id), eq(partnerTwins.userId, userId)));
  if (!svc || twin?.blockedAt) return new Set();
  return new Set(svc.grantedScopes as string[]);
}

/** Phone country once verified, else sign-up country, must be on the allowlist (Part C5). */
export async function inAllowedCountry(db: Db, user: Pick<typeof users.$inferSelect, 'phoneCountry' | 'signupCountry' | 'phoneE164'>, offerCountries: string[]) {
  // Only verified people appear to partners (Phase 2.3).
  if (!user.phoneE164) return false;
  const s = await countrySettings(db);
  const c = user.phoneCountry ?? user.signupCountry;
  return Boolean(c && countryAllowed(s, c) && (!offerCountries.length || offerCountries.includes(c)));
}

// --- credentials ---

export async function createCredentials(db: Db, partnerId: string, label?: string) {
  const clientId = `ipc_${randomBytes(9).toString('base64url')}`;
  const secret = `ips_${randomBytes(24).toString('base64url')}`;
  await db.insert(partnerCredentials).values({ clientId, partnerId, secretHash: await hashPassword(secret), label });
  return { client_id: clientId, client_secret: secret };
}

export async function checkCredentials(db: Db, clientId: string, secret: string) {
  const [cred] = await db.select().from(partnerCredentials).where(and(eq(partnerCredentials.clientId, clientId), isNull(partnerCredentials.revokedAt)));
  if (!cred || !(await verifyPassword(secret, cred.secretHash))) return null;
  const [partner] = await db.select().from(partners).where(eq(partners.id, cred.partnerId));
  if (!partner) return null;
  await db.update(partnerCredentials).set({ lastUsedAt: new Date() }).where(eq(partnerCredentials.clientId, clientId));
  return partner;
}

// --- rate limits (HACKATHON: in memory, per process) ---
const windows = new Map<string, { minute: number; n: number }>();
export function rateLimited(partnerId: string, perMin: number): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  const w = windows.get(partnerId);
  if (!w || w.minute !== minute) { windows.set(partnerId, { minute, n: 1 }); return false; }
  w.n++;
  return w.n > perMin;
}
