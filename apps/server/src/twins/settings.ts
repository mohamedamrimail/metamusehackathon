import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { settings } from '../db/schema.ts';

// Admin settings for contacts, invites and twin-to-twin planning (settings row 'twins'; Admin → Twins).

export interface TwinSettings {
  /** Referral: AI credit for both sides once the invitee verified WhatsApp. */
  referralCreditUsd: number;
  /** Rewarded invites per inviter, ever. */
  referralMaxRewarded: number;
  /** Personal invite links let people past the country gate (default off: they see the waitlist). */
  invitesBypassCountry: boolean;
  invitesPerDay: number;
  connectRequestsPerDay: number;
  /** Set once Meta approved twin_connect_request / twin_plan_request / twin_plan_confirmed. */
  waTemplatesApproved: boolean;
}

export const TWIN_DEFAULTS: TwinSettings = {
  referralCreditUsd: 1, referralMaxRewarded: 10, invitesBypassCountry: false, invitesPerDay: 10, connectRequestsPerDay: 20, waTemplatesApproved: false,
};

let cache: { at: number; value: TwinSettings } | undefined;

export async function twinSettings(db: Db): Promise<TwinSettings> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const [row] = await db.select().from(settings).where(eq(settings.key, 'twins'));
  const value = { ...TWIN_DEFAULTS, ...((row?.value as Partial<TwinSettings> | undefined) ?? {}) };
  cache = { at: Date.now(), value };
  return value;
}

export async function saveTwinSettings(db: Db, patch: Partial<TwinSettings>, by: string): Promise<TwinSettings> {
  const value = { ...(await twinSettings(db)), ...patch };
  await db.insert(settings).values({ key: 'twins', value, updatedBy: by })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: by, updatedAt: new Date() } });
  cache = undefined;
  return value;
}
export const clearTwinSettingsCache = () => { cache = undefined; };
