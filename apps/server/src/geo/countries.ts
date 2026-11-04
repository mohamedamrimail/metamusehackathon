import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { open, type CountryResponse, type Reader } from 'maxmind';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { allowlistActive, config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { bypassEmails, inviteCodes, settings } from '../db/schema.ts';

// Country allowlist (Part C). Sign-up and login are open only in allowed countries, with bypasses
// (invite codes, emails). A verified phone's region beats the IP: a verified user can travel.

export interface CountrySettings {
  allowed: string[];
  /** Visitors from any country may view public twin pages. */
  publicPagesWorldwide: boolean;
  /** No longer used: existing accounts always keep access (loginDecision). Kept so stored settings still parse. */
  existingUsersKeepAccess: boolean;
}

const DEFAULTS = (): CountrySettings => ({
  allowed: config.ALLOWED_COUNTRIES.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean),
  publicPagesWorldwide: true,
  existingUsersKeepAccess: true,
});

let cache: { at: number; value: CountrySettings } | undefined;

/** DB overrides .env; cached for 10 s so an admin change applies everywhere almost at once. */
export async function countrySettings(db: Db): Promise<CountrySettings> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const [row] = await db.select().from(settings).where(eq(settings.key, 'countries'));
  const value = { ...DEFAULTS(), ...((row?.value as Partial<CountrySettings> | undefined) ?? {}) };
  cache = { at: Date.now(), value };
  return value;
}
export const clearCountryCache = () => { cache = undefined; };

/** True when people from this country may sign up (always, when the allowlist is off: see allowlistActive). */
export const countryAllowed = (s: CountrySettings, country: string | null | undefined): boolean =>
  !allowlistActive() || Boolean(country && s.allowed.includes(country));

/** The phone number's region (not just its calling code: +1 is the US, Canada and more). */
export function phoneRegion(e164: string): string | null {
  return parsePhoneNumberFromString(e164)?.country ?? null;
}

// --- IP country: MaxMind GeoLite2 Country, a local file refreshed monthly ---

const GEO_DIR = join(config.UPLOAD_DIR, '..', 'geo');
const GEO_FILE = join(GEO_DIR, 'GeoLite2-Country.mmdb');
/** Fallback until a MaxMind key is set: DB-IP's free "IP to Country Lite" (same format, CC BY 4.0). */
const DBIP_FILE = join(GEO_DIR, 'dbip-country-lite.mmdb');
let reader: Reader<CountryResponse> | null | undefined;

export type GeoLookup = (ip: string, headers: Record<string, string | string[] | undefined>) => Promise<string | null>;

export const maxmindGeo: GeoLookup = async (ip) => {
  if (reader === undefined) reader = await open<CountryResponse>(GEO_FILE).catch(() => open<CountryResponse>(DBIP_FILE)).catch(() => null);
  return reader?.get(ip)?.country?.iso_code ?? null;
};

/** Downloads the GeoLite2 Country database (needs MAXMIND_ACCOUNT_ID + MAXMIND_LICENSE_KEY). */
export async function updateGeoDb(force = false): Promise<boolean> {
  if (!config.MAXMIND_ACCOUNT_ID || !config.MAXMIND_LICENSE_KEY) return updateDbIp(force);
  const age = await stat(GEO_FILE).then((s) => Date.now() - s.mtimeMs).catch(() => Infinity);
  if (!force && age < 25 * 86_400_000) return true;
  const res = await fetch('https://download.maxmind.com/geoip/databases/GeoLite2-Country/download?suffix=tar.gz', {
    headers: { Authorization: `Basic ${Buffer.from(`${config.MAXMIND_ACCOUNT_ID}:${config.MAXMIND_LICENSE_KEY}`).toString('base64')}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`MaxMind download ${res.status}`);
  const dir = await mkdtemp(join(tmpdir(), 'geo-'));
  try {
    await writeFile(join(dir, 'db.tar.gz'), Buffer.from(await res.arrayBuffer()));
    await promisify(execFile)('tar', ['-xzf', join(dir, 'db.tar.gz'), '-C', dir]);
    const sub = (await readdir(dir)).find((d) => d.startsWith('GeoLite2-Country_'));
    if (!sub) throw new Error('MaxMind archive without database');
    await mkdir(GEO_DIR, { recursive: true });
    await rename(join(dir, sub, 'GeoLite2-Country.mmdb'), GEO_FILE);
    reader = undefined; // reopen on next lookup
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** DB-IP Lite: monthly file, no key. Attribution: "IP Geolocation by DB-IP" (privacy page). */
async function updateDbIp(force: boolean): Promise<boolean> {
  const age = await stat(DBIP_FILE).then((s) => Date.now() - s.mtimeMs).catch(() => Infinity);
  if (!force && age < 25 * 86_400_000) return true;
  const month = (d: Date) => d.toISOString().slice(0, 7);
  const now = new Date();
  for (const m of [month(now), month(new Date(now.getFullYear(), now.getMonth() - 1, 15))]) {
    const res = await fetch(`https://download.db-ip.com/free/dbip-country-lite-${m}.mmdb.gz`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) continue;
    await mkdir(GEO_DIR, { recursive: true });
    await writeFile(`${DBIP_FILE}.tmp`, gunzipSync(Buffer.from(await res.arrayBuffer())));
    await rename(`${DBIP_FILE}.tmp`, DBIP_FILE);
    reader = undefined;
    return true;
  }
  throw new Error('DB-IP download failed');
}

// --- decisions ---

export type Decision = { allowed: true; via: 'country' | 'invite' | 'bypass' | 'phone' | 'existing'; judge?: boolean; cohort?: string | null } | { allowed: false; country: string | null };

/** Sign-up: allowed country, or a valid invite code (consumed), or a bypass email. Unknown country → not allowed. */
export async function signupDecision(db: Db, input: { email: string; country: string | null; inviteCode?: string }): Promise<Decision> {
  const s = await countrySettings(db);
  // Atomic: only counts if a use is left and it hasn't expired.
  const useCode = async (kind?: string) => input.inviteCode ? (await db.update(inviteCodes).set({ uses: sql`${inviteCodes.uses} + 1` }).where(and(
    eq(inviteCodes.code, input.inviteCode.trim().toUpperCase()),
    gt(inviteCodes.maxUses, inviteCodes.uses),
    or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, new Date())),
    ...(kind ? [eq(inviteCodes.kind, kind)] : []),
  )).returning())[0] : undefined;
  // A judges' code counts from any country, so the account is always marked as a judge's.
  const judge = await useCode('judge');
  if (judge) return { allowed: true, via: 'invite', judge: true, cohort: judge.cohort };
  // A cohort code (e.g. a pilot session) is counted even in allowed countries, so the cohort is known.
  const cohortCode = input.inviteCode ? (await db.select().from(inviteCodes).where(eq(inviteCodes.code, input.inviteCode.trim().toUpperCase())))[0] : undefined;
  if (cohortCode?.cohort) {
    const used = await useCode();
    if (used) return { allowed: true, via: 'invite', cohort: used.cohort };
  }
  if (countryAllowed(s, input.country)) return { allowed: true, via: 'country' };
  const [bypass] = await db.select().from(bypassEmails).where(eq(bypassEmails.email, input.email.toLowerCase()));
  if (bypass) return { allowed: true, via: 'bypass' };
  const used = await useCode();
  if (used) return { allowed: true, via: 'invite', cohort: used.cohort };
  return { allowed: false, country: input.country };
}

/**
 * Login: every existing account signs in from anywhere. The country gate (and beta approval) applies to new
 * sign-ups only, decided Nov 1. Kept as a function so the sign-in paths stay unchanged.
 */
export async function loginDecision(_db: Db, _user: { email: string }, _country: string | null): Promise<Decision> {
  return { allowed: true, via: 'existing' };
}
