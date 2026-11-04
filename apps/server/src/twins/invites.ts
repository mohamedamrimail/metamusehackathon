import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, gt, gte, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { mailTransport } from '../lib/mailer.ts';
import { emailRefusal } from '../agent/email-limits.ts';
import { usdToMicros } from '../billing/credits.ts';
import { config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { contacts, inviteSuppressions, invites, users } from '../db/schema.ts';
import { ipersonOf, logDone } from './activity.ts';
import { identifierHmac, normaliseEmail, normalisePhone } from './identifiers.ts';
import { twinSettings } from './settings.ts';
import type { InviteInfo } from './view.ts';
import { REMIND_AFTER_MS } from './view.ts';

// §3 Inviting a contact. Email invites are sent by i-persons after the user taps Send (that tap is the
// approval). WhatsApp invites are sent by the USER from their own WhatsApp (wa.me link or the share
// sheet): the i-persons Business number never messages people who didn't opt in.

export const INVITE_TTL_MS = 30 * 86_400_000;
const DAY = 86_400_000;

type Contact = typeof contacts.$inferSelect;
type User = typeof users.$inferSelect;
type Invite = typeof invites.$inferSelect;

export const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;
export const joinLink = (token: string) => `${config.PUBLIC_URL}/join/${token}`;
export const unsubscribeLink = (token: string) => `${config.PUBLIC_URL}/api/invites/${token}/unsubscribe`;

export function inviteText(inviterName: string, link: string): string {
  return `${firstNameOf(inviterName)} invites you to i-persons, a digital twin that plans with you and never acts without your yes. Your twins can then set up meetings and dinners for you. Join here: ${link}`;
}

/** The invite currently valid for this contact (any channel), if any. */
export async function currentInvite(db: Db, inviterId: string, contactId: string, now = new Date()): Promise<Invite | undefined> {
  const [row] = await db.select().from(invites)
    .where(and(eq(invites.inviterId, inviterId), eq(invites.contactId, contactId), gt(invites.expiresAt, now)))
    .orderBy(desc(invites.sentAt)).limit(1);
  return row;
}

/** Invites sent per contact, for the contacts list (only the still-valid ones count as "Invited"). */
export async function inviteInfos(db: Db, inviterId: string, now = new Date()): Promise<Map<string, InviteInfo>> {
  const rows = await db.select().from(invites).where(and(eq(invites.inviterId, inviterId), gt(invites.expiresAt, now), isNotNull(invites.contactId)));
  const out = new Map<string, InviteInfo>();
  for (const r of rows) {
    const prev = out.get(r.contactId!);
    if (!prev || prev.at < r.sentAt) out.set(r.contactId!, { channel: r.channel as 'email' | 'whatsapp', at: r.sentAt, reminded: Boolean(r.remindedAt) });
  }
  return out;
}

export const isSuppressed = async (db: Db, email: string) =>
  Boolean((await db.select().from(inviteSuppressions).where(eq(inviteSuppressions.emailHmac, identifierHmac('email', email))))[0]);

/**
 * §7 limits: 10 invites a day, one per contact per 30 days plus one reminder after 7 days, never to a
 * suppressed address, never to someone already on i-persons. null = allowed.
 */
export async function inviteRefusal(db: Db, inviter: User, contact: Contact, channel: 'email' | 'whatsapp', opts: { remind?: boolean; email?: string; now?: Date } = {}): Promise<string | null> {
  const now = opts.now ?? new Date();
  if (contact.hasIperson) return `${contact.name} already has an i-person: connect your twins instead.`;
  const { invitesPerDay } = await twinSettings(db);
  const [today] = await db.select({ n: count() }).from(invites).where(and(eq(invites.inviterId, inviter.id), or(gte(invites.sentAt, new Date(now.getTime() - DAY)), gte(invites.remindedAt, new Date(now.getTime() - DAY)))));
  if ((today?.n ?? 0) >= invitesPerDay) return `You can send at most ${invitesPerDay} invites a day. Try again tomorrow.`;
  const existing = await currentInvite(db, inviter.id, contact.id, now);
  if (existing && !opts.remind) return `You already invited ${contact.name} on ${existing.sentAt.toISOString().slice(0, 10)}. You can send one reminder after 7 days.`;
  if (opts.remind) {
    if (!existing) return 'There is no invite to remind them of.';
    if (existing.remindedAt) return `You already reminded ${contact.name} once.`;
    if (now.getTime() - existing.sentAt.getTime() < REMIND_AFTER_MS) return 'You can send a reminder 7 days after the invite.';
  }
  if (channel === 'email') {
    if (!opts.email) return `${contact.name} has no email address in your contacts.`;
    if (await isSuppressed(db, opts.email)) return 'This address asked not to receive i-persons invites.';
  }
  return null;
}

async function upsertInvite(db: Db, inviterId: string, contactId: string, channel: 'email' | 'whatsapp', email: string | null, remind: boolean, now: Date): Promise<Invite> {
  const existing = await currentInvite(db, inviterId, contactId, now);
  if (existing) {
    const [row] = await db.update(invites).set({
      channel, ...(email ? { emailHmac: identifierHmac('email', email) } : {}), ...(remind ? { remindedAt: now } : {}),
    }).where(eq(invites.id, existing.id)).returning();
    return row!;
  }
  const [row] = await db.insert(invites).values({
    inviterId, contactId, channel, token: randomBytes(18).toString('base64url'), emailHmac: email ? identifierHmac('email', email) : null,
    sentAt: now, expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
  }).returning();
  return row!;
}

const transport = () => (config.SMTP_URL ? mailTransport(config.SMTP_URL) : undefined);

/** The prefilled texts and channels for the invite sheet. */
export async function invitePrefill(db: Db, inviter: User, contact: Contact) {
  const existing = await currentInvite(db, inviter.id, contact.id);
  // The link shown before sending is a preview; the real token is made when the invite goes out.
  const link = existing ? joinLink(existing.token) : `${config.PUBLIC_URL}/join/…`;
  const country = inviter.phoneCountry ?? inviter.country ?? inviter.signupCountry;
  const phones = ((contact.phones as string[]) ?? []).map((p) => normalisePhone(p, country)).filter((p): p is string => Boolean(p));
  return {
    text: inviteText(inviter.name, link).replace(/ Join here: .*$/, ''),
    emails: ((contact.emails as string[]) ?? []).map(normaliseEmail).filter((e): e is string => Boolean(e)),
    phones,
    reply_to_available: Boolean(inviter.emailVerifiedAt),
    invited: existing ? { channel: existing.channel, at: existing.sentAt.toISOString(), reminded: Boolean(existing.remindedAt) } : null,
  };
}

/** Sends (or, without SMTP, keeps in the outbox) an email invite. Throws a user-facing message on refusal. */
export async function sendEmailInvite(db: Db, inviter: User, contact: Contact, opts: { email: string; message?: string; replyTo?: boolean; remind?: boolean; now?: Date }) {
  const now = opts.now ?? new Date();
  const email = normaliseEmail(opts.email);
  if (!email || !((contact.emails as string[]) ?? []).map(normaliseEmail).includes(email)) throw new InviteError('Pick one of this contact’s email addresses.');
  const refusal = await inviteRefusal(db, inviter, contact, 'email', { remind: opts.remind, email, now });
  if (refusal) throw new InviteError(refusal);
  const ipersonId = await ipersonOf(db, inviter.id);
  const message = (opts.message?.trim() || inviteText(inviter.name, '').replace(/ Join here: $/, '')).slice(0, 600);
  // Invites count against the user's email limits (and need a verified WhatsApp number, like any email).
  const limit = ipersonId ? await emailRefusal(db, ipersonId, [email], message, now) : 'Finish creating your i-person first.';
  if (limit) throw new InviteError(limit);

  const invite = await upsertInvite(db, inviter.id, contact.id, 'email', email, Boolean(opts.remind), now);
  const link = joinLink(invite.token);
  const stop = unsubscribeLink(invite.token);
  const text = `${message.includes(link) ? message : `${message}\n\nJoin here: ${link}`}\n\n—\nSent by i-persons.com because ${inviter.name} asked us to. Don't send me invites again: ${stop}`;
  const mail = {
    from: { name: `${firstNameOf(inviter.name)} via i-persons`, address: config.INVITE_FROM },
    to: email,
    ...(opts.replyTo && inviter.emailVerifiedAt ? { replyTo: inviter.email } : {}),
    subject: opts.remind ? `Reminder: ${firstNameOf(inviter.name)} invited you to i-persons` : `${firstNameOf(inviter.name)} invites you to i-persons`,
    text,
    headers: { 'List-Unsubscribe': `<${stop}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
  const t = transport();
  let result: { delivered: boolean; outbox?: boolean; text?: string; message_id?: string };
  if (t) {
    const info = await t.sendMail(mail);
    result = info.skipped ? { delivered: false, outbox: true, text } : { delivered: true, message_id: info.messageId };
  } else {
    // HACKATHON: no SMTP configured; the action log keeps the message as the outbox.
    result = { delivered: false, outbox: true, text };
  }
  await db.update(contacts).set({ inviteStatus: 'email' }).where(eq(contacts.id, contact.id));
  await logDone(db, inviter.id, {
    tool: 'invite_contact', args: { to: [email], channel: 'email', contact_id: contact.id, remind: Boolean(opts.remind) },
    summary: `${opts.remind ? 'Reminded' : 'Invited'} ${contact.name} to i-persons by email`, result,
  });
  return { sent: true, ...result };
}

/**
 * WhatsApp invite: never sent by i-persons. Returns the wa.me link (or the text for the share sheet when
 * the contact has no number) and records "Invited via WhatsApp" when the user taps the button.
 */
export async function recordWhatsappInvite(db: Db, inviter: User, contact: Contact, opts: { message?: string; remind?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const refusal = await inviteRefusal(db, inviter, contact, 'whatsapp', { remind: opts.remind, now });
  if (refusal) throw new InviteError(refusal);
  const invite = await upsertInvite(db, inviter.id, contact.id, 'whatsapp', null, Boolean(opts.remind), now);
  const link = joinLink(invite.token);
  const base = opts.message?.trim().slice(0, 600) || inviteText(inviter.name, '').replace(/ Join here: $/, '');
  const text = base.includes(link) ? base : `${base} Join here: ${link}`;
  const country = inviter.phoneCountry ?? inviter.country ?? inviter.signupCountry;
  const phone = ((contact.phones as string[]) ?? []).map((p) => normalisePhone(p, country)).find(Boolean);
  await db.update(contacts).set({ inviteStatus: 'whatsapp' }).where(eq(contacts.id, contact.id));
  await logDone(db, inviter.id, {
    tool: 'invite_contact', args: { channel: 'whatsapp', contact_id: contact.id, remind: Boolean(opts.remind) },
    summary: `${opts.remind ? 'Reminded' : 'Invited'} ${contact.name} via WhatsApp (sent from your own WhatsApp)`, result: { via: phone ? 'wa.me' : 'share' },
  });
  return phone ? { wa_link: `https://wa.me/${phone.replace(/^\+/, '')}?text=${encodeURIComponent(text)}`, text } : { share_text: text, text };
}

export class InviteError extends Error {}

// --- the invitee's side ---

export async function inviteByToken(db: Db, token: string, now = new Date()) {
  if (!/^[\w-]{10,64}$/.test(token)) return undefined;
  const [row] = await db.select({ invite: invites, inviter: users }).from(invites).innerJoin(users, eq(users.id, invites.inviterId)).where(eq(invites.token, token));
  if (!row) return undefined;
  return { ...row, valid: row.invite.expiresAt > now };
}

/** "Don't send me invites again": suppresses that address for every user. */
export async function suppressByToken(db: Db, token: string): Promise<boolean> {
  const found = await inviteByToken(db, token, new Date(0));
  if (!found?.invite.emailHmac) return false;
  await db.insert(inviteSuppressions).values({ emailHmac: found.invite.emailHmac }).onConflictDoNothing();
  return true;
}

/** Links a new account to the invite it came from (once per account, never the inviter themselves). */
export async function acceptInvite(db: Db, token: string, userId: string, now = new Date()): Promise<boolean> {
  const found = await inviteByToken(db, token, now);
  if (!found?.valid || found.invite.inviterId === userId || found.invite.acceptedUserId) return false;
  const [already] = await db.select({ id: invites.id }).from(invites).where(eq(invites.acceptedUserId, userId));
  if (already) return false;
  const [u] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId));
  // Only accounts created after the invite went out count as joining through it.
  if (!u || u.createdAt < found.invite.sentAt) return false;
  const [row] = await db.update(invites).set({ acceptedUserId: userId, acceptedAt: now })
    .where(and(eq(invites.id, found.invite.id), isNull(invites.acceptedUserId))).returning();
  if (row) {
    // Growth §2: the invitee joins the inviter's cohort, marked as a referral.
    const [inviter] = await db.select({ cohort: users.cohort }).from(users).where(eq(users.id, row.inviterId));
    await db.update(users).set({ cohort: inviter?.cohort ?? null, referral: true }).where(eq(users.id, userId));
  }
  return Boolean(row);
}

/**
 * Referral credit (§3c): once the invitee verified WhatsApp, both get the admin-set credit, paid once
 * per invite, at most `referralMaxRewarded` times per inviter. Returns the paid invite, if any.
 */
export async function payReferral(db: Db, inviteeId: string, now = new Date()): Promise<Invite | undefined> {
  const [invitee] = await db.select().from(users).where(eq(users.id, inviteeId));
  if (!invitee?.phoneE164) return undefined;
  const [inv] = await db.select().from(invites).where(and(eq(invites.acceptedUserId, inviteeId), isNull(invites.rewardedAt)));
  if (!inv) return undefined;
  const s = await twinSettings(db);
  const [paid] = await db.select({ n: count() }).from(invites).where(and(eq(invites.inviterId, inv.inviterId), isNotNull(invites.rewardedAt), gt(invites.rewardMicros, 0)));
  const micros = (paid?.n ?? 0) < s.referralMaxRewarded ? usdToMicros(s.referralCreditUsd) : 0;
  return db.transaction(async (tx) => {
    // The conditional update makes it once-only even if two verifications race.
    const [row] = await tx.update(invites).set({ rewardedAt: now, rewardMicros: micros }).where(and(eq(invites.id, inv.id), isNull(invites.rewardedAt))).returning();
    if (!row || micros <= 0) return row;
    for (const id of [inv.inviterId, inviteeId]) {
      await tx.update(users).set({ aiCreditMicros: sql`${users.aiCreditMicros} + ${micros}` }).where(eq(users.id, id));
    }
    return row;
  });
}

/** Whether a personal invite link may let its holder past the country gate (admin toggle, default off). */
export async function joinBypassesCountry(db: Db, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const found = await inviteByToken(db, token);
  return Boolean(found?.valid && (await twinSettings(db)).invitesBypassCountry);
}
