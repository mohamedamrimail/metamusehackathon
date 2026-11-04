import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { mailTransport } from '../lib/mailer.ts';
import type { ActionRow } from '../agent/runtime.ts';
import { proposedEvent } from '../channels/events.ts';
import { config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { actions, calendarEvents, ipersons, partnerApplications, partnerOffers, partnerRequests, partners, users } from '../db/schema.ts';
import type { AppDeps } from '../http/deps.ts';
import { ensureTwin } from './core.ts';
import { shareableFacts } from './matching.ts';
import { emit } from './webhooks.ts';

// Partner requests (P5): every request is an Approve/Decline card on web + WhatsApp. Nothing is
// shared before the user's yes; on yes, exactly what was asked is shared once.

export const REQUEST_KINDS = ['share_cv', 'share_contact', 'schedule', 'custom'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const MAX_PENDING_PER_USER = 3;
/** Partners can't expect an answer within the usual 10 minutes. */
const REQUEST_TTL_MS = 72 * 3_600_000;

function summary(partnerName: string, kind: RequestKind, payload: { slots?: string[]; text?: string }, offerTitle?: string) {
  const about = offerTitle ? ` (${offerTitle})` : '';
  if (kind === 'share_cv') return `${partnerName} asks for your CV${about}`;
  if (kind === 'share_contact') return `${partnerName} asks for your name, email and phone${about}`;
  if (kind === 'schedule') {
    const first = payload.slots?.[0] ? new Date(payload.slots[0]).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : 'a time';
    return `${partnerName} asks to schedule an interview${about}: ${first}${(payload.slots?.length ?? 0) > 1 ? ` (or ${payload.slots!.length - 1} other slot${payload.slots!.length > 2 ? 's' : ''})` : ''}`;
  }
  return `${partnerName} asks: ${String(payload.text ?? '').slice(0, 140)}${about}`;
}

/** Creates the request and its approval card (an action only the runtime can execute). */
export async function createRequest(deps: AppDeps, partner: typeof partners.$inferSelect, userId: string, input: { kind: RequestKind; offerId?: string; payload: { slots?: string[]; text?: string } }) {
  const { db } = deps;
  const [ip] = await db.select().from(ipersons).where(eq(ipersons.userId, userId));
  if (!ip) throw new Error('no twin');
  const [offer] = input.offerId ? await db.select().from(partnerOffers).where(and(eq(partnerOffers.id, input.offerId), eq(partnerOffers.partnerId, partner.id))) : [];
  const [req] = await db.insert(partnerRequests).values({ partnerId: partner.id, offerId: offer?.id ?? null, userId, kind: input.kind, payload: input.payload }).returning();
  const now = new Date();
  const [action] = await db.insert(actions).values({
    ipersonId: ip.id, tool: 'partner_request', args: { request_id: req!.id }, risk: 'write', status: 'proposed',
    summary: summary(partner.name, input.kind, input.payload, offer?.title), confirmToken: randomBytes(16).toString('base64url'),
    expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
  }).returning();
  await db.update(partnerRequests).set({ actionId: action!.id }).where(eq(partnerRequests.id, req!.id));
  deps.bus.publish(ip.id, proposedEvent(action!));
  await sendCardToWhatsApp(deps, userId, action!);
  return { ...req!, actionId: action!.id };
}

async function sendCardToWhatsApp(deps: AppDeps, userId: string, a: ActionRow) {
  const [u] = await deps.db.select({ phone: users.phoneE164 }).from(users).where(eq(users.id, userId));
  if (!deps.wa || !u?.phone) return;
  await deps.wa.sendButtons(u.phone.replace(/^\+/, ''), a.summary, [{ id: `ok:${a.confirmToken}`, title: 'Approve' }, { id: `no:${a.confirmToken}`, title: 'Decline' }]).catch(() => {});
}

const contactEmailOf = async (db: Db, partnerId: string) =>
  (await db.select({ email: partnerApplications.email }).from(partnerApplications).where(eq(partnerApplications.partnerId, partnerId)))[0]?.email;

/** Runs when the user approves (via the internal partner_request tool). */
export async function fulfilRequest(deps: AppDeps, requestId: string) {
  const { db } = deps;
  const [req] = await db.select().from(partnerRequests).where(eq(partnerRequests.id, requestId));
  if (!req || req.status !== 'pending') return { error: 'request is no longer pending' };
  const [partner] = await db.select().from(partners).where(eq(partners.id, req.partnerId));
  const [user] = await db.select().from(users).where(eq(users.id, req.userId));
  const [ip] = await db.select().from(ipersons).where(eq(ipersons.userId, req.userId));
  const [offer] = req.offerId ? await db.select().from(partnerOffers).where(eq(partnerOffers.id, req.offerId)) : [];
  const payload = req.payload as { slots?: string[]; text?: string };
  let shared: Record<string, unknown>;

  if (req.kind === 'share_contact') {
    shared = { name: user!.name, email: user!.email, phone: user!.phoneE164 };
  } else if (req.kind === 'share_cv') {
    // HACKATHON: no CV upload yet; the user approves sharing a profile summary built from their facts.
    shared = { profile: (await shareableFacts(db, req.userId)).map((f) => `${f.key.replace(/_/g, ' ')}: ${f.value}`), name: user!.name };
  } else if (req.kind === 'schedule') {
    const slot = await firstFreeSlot(db, ip!.id, payload.slots ?? []);
    if (!slot) return { error: 'none of the proposed times is free in your calendar' };
    const end = new Date(slot.getTime() + 45 * 60_000);
    await db.insert(calendarEvents).values({ ipersonId: ip!.id, title: `Interview with ${partner!.name}${offer ? `: ${offer.title}` : ''}`, startsAt: slot, endsAt: end, location: 'Online' });
    shared = { slot: slot.toISOString(), duration_minutes: 45, name: user!.name, email: user!.email };
    const to = await contactEmailOf(db, partner!.id);
    if (to && config.SMTP_URL) {
      await mailTransport(config.SMTP_URL).sendMail({
        from: config.SMTP_FROM, to, replyTo: user!.email, subject: `Interview confirmed: ${user!.name}${offer ? ` — ${offer.title}` : ''}`,
        text: `${user!.name} accepted your interview request.\n\nWhen: ${slot.toUTCString()} (45 minutes)\nContact: ${user!.email}\n\n— sent by ${user!.name}'s i-person`,
      }).catch(() => {});
    }
  } else {
    shared = { approved: true, text: payload.text ?? '' };
  }

  await db.update(partnerRequests).set({ status: 'approved', shared, decidedAt: new Date() }).where(eq(partnerRequests.id, req.id));
  const twinId = await ensureTwin(db, req.partnerId, req.userId);
  // The shared data goes out once: in this webhook (and the next GET), then it's cleared.
  await emit(db, req.partnerId, 'request.approved', { request_id: req.id, twin_id: twinId, kind: req.kind, shared });
  return { shared_with: partner!.name, kind: req.kind, ...(req.kind === 'schedule' ? { slot: shared.slot } : {}) };
}

async function firstFreeSlot(db: Db, ipersonId: string, slots: string[]) {
  const busy = await db.select().from(calendarEvents).where(eq(calendarEvents.ipersonId, ipersonId));
  for (const s of slots) {
    const start = new Date(s);
    if (Number.isNaN(start.getTime()) || start < new Date()) continue;
    const end = new Date(start.getTime() + 45 * 60_000);
    if (!busy.some((e) => e.startsAt < end && e.endsAt > start)) return start;
  }
  return null;
}

/** Declined or expired card → request status + webhook (wired as the runtime's onSettled). */
export async function settleRequest(deps: AppDeps, action: ActionRow) {
  if (action.tool !== 'partner_request') return;
  const status = action.status === 'rejected' ? 'declined' : action.status === 'expired' ? 'expired' : null;
  if (!status) return;
  const id = (action.args as { request_id?: string }).request_id;
  if (!id) return;
  const [req] = await deps.db.update(partnerRequests).set({ status, decidedAt: new Date() })
    .where(and(eq(partnerRequests.id, id), eq(partnerRequests.status, 'pending'))).returning();
  if (!req) return;
  await emit(deps.db, req.partnerId, status === 'declined' ? 'request.declined' : 'request.expired', { request_id: req.id, twin_id: await ensureTwin(deps.db, req.partnerId, req.userId), kind: req.kind });
}
