import { eq } from 'drizzle-orm';
import { config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { settings } from '../db/schema.ts';

// Phase 4a Settings: values from .env that the admin can change at runtime (DB overrides .env).

export interface RuntimeSettings {
  freeCreditUsd: number;
  feeRatio: number;
  emailPerHour: number;
  emailPerDay: number;
  /** Impact §1: show "Hours given back to our users" on the landing page (off until the number is meaningful). */
  showImpactCounter: boolean;
  /** Impact §3: AI credit for a WhatsApp guest twin. */
  guestCreditUsd: number;
  /** Beta: new accounts (not judges, demo or admins) wait for approval (lib/approval.ts). */
  requireApproval: boolean;
  /** Impact §4: the Plus plan's monthly price shown on /pricing (not sold yet), and the gift amounts offered. */
  plusPriceUsd: number;
  giftPresetsUsd: number[];
  /** Impact §9: show "People in <n> countries are waiting for i-persons" on the landing page. */
  showWaitlistLine: boolean;
  /** DEMO: the live "Meta AI calls" panel on demo accounts (lib/call-log.ts). */
  showCallsPanel: boolean;
}

const defaults = (): RuntimeSettings => ({
  freeCreditUsd: config.AI_FREE_CREDIT_USD,
  feeRatio: config.AI_PLATFORM_FEE_RATIO,
  emailPerHour: 5,
  emailPerDay: 20,
  showImpactCounter: false,
  guestCreditUsd: 1,
  requireApproval: config.BETA_APPROVAL === 'on',
  plusPriceUsd: 9,
  giftPresetsUsd: [5, 10, 25],
  showWaitlistLine: false,
  showCallsPanel: config.CALLS_PANEL === 'on',
});

let cache: { at: number; value: RuntimeSettings } | undefined;

export async function runtimeSettings(db: Db): Promise<RuntimeSettings> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const [row] = await db.select().from(settings).where(eq(settings.key, 'runtime'));
  const value = { ...defaults(), ...((row?.value as Partial<RuntimeSettings> | undefined) ?? {}) };
  cache = { at: Date.now(), value };
  return value;
}
export const clearRuntimeCache = () => { cache = undefined; };
