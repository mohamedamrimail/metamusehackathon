import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { CONSENT_VERSION } from '@ipersons/shared';
import { usdToMicros } from '../billing/credits.ts';
import { config } from '../config.ts';
import { avatarAssets, ipersons, magicLinks, users } from '../db/schema.ts';
import { countryAllowed, countrySettings, phoneRegion } from '../geo/countries.ts';
import type { AppDeps } from '../http/deps.ts';
import { approvalFor, notifyNewAccount } from '../lib/approval.ts';
import { limited } from '../lib/ratelimit.ts';
import { runtimeSettings } from '../lib/settings.ts';

// Impact §3: WhatsApp-first guest twins. An unknown number that messages us (so the 24-hour window is
// open) gets a welcome and a consent question with buttons; nothing reaches the model before "I'm 18+ and
// agree". The guest twin can chat, answer, find things and send hand-off links; the rest needs the web,
// reached through a single-use 15-minute magic link.

export const GUEST_DAILY_MESSAGES = 30;
const DAY = 86_400_000;
/** What a guest twin can't do yet (the twin offers the web link instead). */
export const GUEST_BLOCKED_TOOLS = new Set(['send_email', 'contacts_search', 'contacts_status', 'invite_contact', 'connect_twins', 'plan_with_contacts', 'partner_request', 'visitor_request']);
export const WEB_LINK = '{{WEB_LINK}}';
export const GUEST_RULE = `This user is a WhatsApp guest. If they ask for something that needs the full twin (sending email, connecting a mailbox, a public link, partners, contacts or planning with friends), reply exactly: "To do this, finish your twin on the web: ${WEB_LINK}" (keep the placeholder as is).`;

const TIMEZONES: Record<string, string> = { TN: 'Africa/Tunis', DE: 'Europe/Berlin', DK: 'Europe/Copenhagen', US: 'America/New_York', FR: 'Europe/Paris' };

/** The guest's language: the first message's script or words, else the number's region. */
export function guessLocale(text: string, region: string | null): string {
  if (/[؀-ۿ]/.test(text)) return 'ar';
  if (/\b(bonjour|salut|merci|je|tu|est-ce|svp|bonsoir)\b/i.test(text)) return 'fr';
  if (/\b(hallo|danke|ich|bitte|guten)\b/i.test(text)) return 'de';
  if (/\b(hello|hi|thanks|please|hey)\b/i.test(text)) return 'en';
  return region === 'DE' ? 'de' : region === 'TN' ? 'fr' : 'en';
}

const WELCOME: Record<string, string> = {
  en: 'Hi! I’m i-persons: a digital twin that knows you, speaks for you and acts for you, but never without your yes. Want to try your own twin right here?',
  fr: 'Bonjour ! Je suis i-persons : un jumeau numérique qui vous connaît, parle et agit pour vous, mais jamais sans votre oui. Voulez-vous essayer votre propre jumeau ici ?',
  ar: 'مرحبا! أنا i-persons: توأم رقمي يعرفك ويتكلم ويتصرف بالنيابة عنك، لكن ليس دون موافقتك. هل تريد تجربة توأمك هنا؟',
  de: 'Hallo! Ich bin i-persons: ein digitaler Zwilling, der dich kennt, für dich spricht und handelt, aber nie ohne dein Ja. Möchtest du deinen eigenen Zwilling hier ausprobieren?',
};

// HACKATHON: the first message waits in memory while the person decides (30 min); a restart forgets it.
const waiting = new Map<string, { text: string; at: number }>();

/** An unknown number wrote: consent buttons (or the waitlist for other countries). Returns true when handled. */
export async function greetUnknown(deps: AppDeps, from: string, phone: string, text: string): Promise<void> {
  const wa = deps.wa!;
  const region = phoneRegion(phone);
  if (!countryAllowed(await countrySettings(deps.db), region)) {
    await wa.sendText(from, `Thanks for writing! i-persons isn’t open for numbers from your country yet. Join the waitlist and we’ll tell you when it is: ${config.PUBLIC_URL}/signup`);
    return;
  }
  if (text) waiting.set(phone, { text, at: Date.now() });
  if (limited(`guest-welcome:${phone}`, 3, DAY)) return;
  const lang = guessLocale(text, region);
  await wa.sendButtons(from, `${WELCOME[lang] ?? WELCOME.en}\n\nTerms: ${config.PUBLIC_URL}/terms.html · Privacy: ${config.PUBLIC_URL}/privacy.html`, [
    { id: 'guest:agree', title: 'I’m 18+ and agree' },
    { id: 'guest:no', title: 'Not now' },
  ]);
}

/** "I'm 18+ and agree": the guest account and twin, with a small credit and a neutral avatar. */
export async function createGuest(deps: AppDeps, phone: string, profileName: string | undefined, log: FastifyBaseLogger) {
  const { db } = deps;
  const region = phoneRegion(phone);
  if (!countryAllowed(await countrySettings(db), region)) return undefined;
  const [existing] = await db.select().from(users).where(eq(users.phoneE164, phone));
  if (existing) return existing;
  const first = waiting.get(phone);
  const name = (profileName ?? '').trim().slice(0, 60) || 'Friend';
  const locale = guessLocale(first?.text ?? '', region);
  const email = `wa-${phone.replace(/\D/g, '')}@guest.i-persons.com`;
  const [user] = await db.insert(users).values({
    email, name, locale, pendingApprovalAt: await approvalFor(db, { email, accountKind: 'user' }), timezone: (region && TIMEZONES[region]) || 'UTC',
    phoneE164: phone, phoneCountry: region, verifiedAt: new Date(), consentVersion: CONSENT_VERSION, consentAt: new Date(),
    aiCreditMicros: usdToMicros((await runtimeSettings(db)).guestCreditUsd), signupCountry: region, guestAt: new Date(), setupStep: 'gift',
  }).returning();
  const [avatar] = await db.select().from(avatarAssets).where(and(eq(avatarAssets.library, true), eq(avatarAssets.variant, 'base'))).limit(1);
  await db.insert(ipersons).values({
    userId: user!.id, displayName: `i-${name.split(/\s+/)[0]}`,
    ...(avatar ? { avatarUrl: avatar.imageUrl, avatarAssetId: avatar.id, avatarMeta: { mouth: (avatar.masks as { mouth?: unknown } | null)?.mouth } } : {}),
  });
  log.info({ region }, 'whatsapp guest created');
  await notifyNewAccount(deps, user!, 'WhatsApp guest', log);
  return user!;
}

/** The first message the guest sent before agreeing, if it's still fresh. */
export function takeWaitingMessage(phone: string): string | undefined {
  const w = waiting.get(phone);
  waiting.delete(phone);
  return w && Date.now() - w.at < 30 * 60_000 ? w.text : undefined;
}

/** Beta: what a guest hears while the team hasn't approved the account yet. */
export const PENDING_GUEST = 'Thanks! i-persons is in beta, so our team approves new accounts first. I’ll message you here as soon as yours is ready.';

export const isGuest = (u: { guestAt: Date | null; onboardedAt: Date | null }) => Boolean(u.guestAt && !u.onboardedAt);

/** Guests: 30 messages a day per number. */
export const guestOverLimit = (phone: string) => limited(`guest-msgs:${phone}`, GUEST_DAILY_MESSAGES, DAY);

/** A single-use magic link (15 min) that signs the guest in on the web to finish setup. */
export async function magicLink(deps: AppDeps, userId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await deps.db.insert(magicLinks).values({ userId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 15 * 60_000) });
  return `${config.PUBLIC_URL}/api/auth/magic/${token}`;
}

/** Redeems a magic link once; returns the user id. */
export async function redeemMagicLink(deps: AppDeps, token: string): Promise<string | undefined> {
  const hash = createHash('sha256').update(token).digest('hex');
  const [row] = await deps.db.update(magicLinks).set({ usedAt: new Date() })
    .where(and(eq(magicLinks.tokenHash, hash), isNull(magicLinks.usedAt), gt(magicLinks.expiresAt, new Date()))).returning();
  return row?.userId;
}
