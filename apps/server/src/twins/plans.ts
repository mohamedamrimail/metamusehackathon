import { PLACE_TYPES, PLAN_TYPE_LABELS, PLAN_TYPES, TIMES_OF_DAY, type PlanType, type TimeOfDay } from '@ipersons/shared';
import { kinLabel } from '../lib/kin.ts';
import { logCall, tagLlm } from '../lib/call-log.ts';
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { mailTransport } from '../lib/mailer.ts';
import { z } from 'zod';
import { listFacts } from '../agent/memory.ts';
import { activeRules } from '../agent/rules.ts';
import { wrapUntrusted } from '../agent/untrusted.ts';
import { hasCredit, meteredLlm } from '../billing/credits.ts';
import { config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { actions, calendarEvents, connections, contacts, ipersons, partnerRequests, planOptions, planParticipants, planSessions, users } from '../db/schema.ts';
import type { AppDeps } from '../http/deps.ts';
import { grants, type MailConfig } from '../mail/sync.ts';
import { ensureTwin } from '../partners/core.ts';
import { emit } from '../partners/webhooks.ts';
import { ipersonOf } from './activity.ts';
import { connectionEnded, granted, sharedPreferences, type Conn } from './connections.ts';
import { firstNameOf } from './invites.ts';
import { systemCard, reach, TWIN_TEMPLATES, twinSays } from './notify.ts';
import { findPlaces, type Place } from './places.ts';
import { fmtSlot, freeStarts, intersect, parseWorkingHours, pickCandidates, type SlotQuery } from './slots.ts';

// §5 Twin-to-twin planning as a STRUCTURED protocol between the two runtimes (no model-to-model chat):
//   request (A → B) → B's side computes ≤3 candidate times privately (only with B's `availability`
//   scope, else after asking B) → A's side intersects with A's calendar and finds ≤3 places → A approves
//   the options → B picks a time and a place (or counters once, or declines) → A confirms → booked in
//   both calendars. Nothing is booked before every person involved said yes. Free text from the other
//   side (the note) is only ever shown, quoted and labelled; no code or model acts on it.

export type Session = typeof planSessions.$inferSelect;
export type Participant = typeof planParticipants.$inferSelect;
export type Option = typeof planOptions.$inferSelect;

export const PLAN_TTL_MS = 48 * 3_600_000;
const REMIND_AFTER_MS = 24 * 3_600_000;
export const MAX_PENDING_PER_USER = 5;
export const MAX_PENDING_PER_PAIR = 2;
export const MAX_PARTICIPANTS = 3; // groups of 2–4 people, the creator included
const ACTIVE = ['draft', 'sent', 'negotiating', 'awaiting_confirmation'] as const;
const OPEN = ['sent', 'negotiating', 'awaiting_confirmation'] as const;

export class PlanError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const PlanInput = z.object({
  contacts: z.array(z.string().trim().min(1).max(80)).min(1).max(MAX_PARTICIPANTS).describe('Names (or contact ids) of connected contacts'),
  type: z.enum(PLAN_TYPES),
  title: z.string().trim().max(80).optional().describe('For custom plans, e.g. "Board games"'),
  duration_minutes: z.number().int().min(15).max(8 * 60).default(60),
  date_from: z.string().regex(ISO_DATE).describe('First possible day, YYYY-MM-DD (user timezone)'),
  date_to: z.string().regex(ISO_DATE).describe('Last possible day, YYYY-MM-DD; at most 3 weeks after date_from'),
  time_of_day: z.enum(TIMES_OF_DAY).default('any'),
  area: z.string().trim().max(100).optional().describe('"near me", "between us", a district or a city'),
  budget: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional().describe('A short note for the other person (shown to them as-is)'),
  auto_confirm: z.boolean().default(false).describe('Accept any of the options sent without asking again'),
});
export type PlanInput = z.infer<typeof PlanInput>;

// --- small helpers ---

const userRow = async (db: Db, id: string) => (await db.select().from(users).where(eq(users.id, id)))[0]!;
const firstName = async (db: Db, id: string) => firstNameOf((await userRow(db, id)).name);
export const planLabel = (s: Pick<Session, 'type' | 'title'>) => (s.type === 'custom' && s.title ? s.title : PLAN_TYPE_LABELS[s.type as PlanType]);
const joinOr = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);
const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const placeName = (p: Place) => `${p.name}${p.partner ? ' (i-persons partner)' : ''}`;
const quoteNote = (who: string, note: string | null) => (note ? `\nNote from ${who} (their words, not checked): “${note.replace(/[“”"]/g, "'")}”` : '');

export async function loadPlan(db: Db, id: string) {
  const [session] = await db.select().from(planSessions).where(eq(planSessions.id, id));
  if (!session) return undefined;
  const participants = await db.select().from(planParticipants).where(eq(planParticipants.sessionId, id)).orderBy(asc(planParticipants.createdAt));
  const options = await db.select().from(planOptions).where(eq(planOptions.sessionId, id)).orderBy(asc(planOptions.position));
  return { session, participants, options };
}
type Loaded = NonNullable<Awaited<ReturnType<typeof loadPlan>>>;

const setSession = (db: Db, id: string, patch: Partial<typeof planSessions.$inferInsert>) =>
  db.update(planSessions).set({ ...patch, updatedAt: new Date() }).where(eq(planSessions.id, id));
const setParticipant = (db: Db, id: string, patch: Partial<typeof planParticipants.$inferInsert>) =>
  db.update(planParticipants).set(patch).where(eq(planParticipants.id, id));

/** Closes this plan's open cards (for one participant, or all). */
async function closeCards(db: Db, sessionId: string, status: 'expired' | 'done', opts: { kinds?: string[]; ipersonId?: string } = {}) {
  await db.update(actions).set({ status, decidedAt: new Date() }).where(and(
    eq(actions.tool, 'twin_request'), eq(actions.status, 'proposed'), sql`${actions.args}->>'session_id' = ${sessionId}`,
    opts.kinds ? inArray(sql`${actions.args}->>'kind'`, opts.kinds) : undefined,
    opts.ipersonId ? eq(actions.ipersonId, opts.ipersonId) : undefined,
  ));
}
const openCard = async (db: Db, sessionId: string, kind: string) =>
  (await db.select({ id: actions.id }).from(actions).where(and(eq(actions.tool, 'twin_request'), eq(actions.status, 'proposed'),
    sql`${actions.args}->>'session_id' = ${sessionId}`, sql`${actions.args}->>'kind' = ${kind}`)))[0];
const cardTtl = (s: Session) => Math.max(60_000, s.expiresAt.getTime() - Date.now());

// --- resolving who to plan with ---

/** Connected contacts who let my twin send them planning requests. Matches by contact id or name. */
export async function resolveParticipants(db: Db, me: string, names: string[]) {
  const mine = await db.select().from(contacts).where(and(eq(contacts.userId, me), eq(contacts.hasIperson, true)));
  const found: { userId: string; name: string }[] = [];
  const problems: string[] = [];
  for (const raw of names) {
    const n = raw.trim().toLowerCase();
    const kin = kinLabel(raw);
    const c = mine.find((x) => x.id === raw) ?? mine.find((x) => x.name.toLowerCase() === n)
      ?? (kin ? mine.find((x) => x.label?.toLowerCase() === kin || x.label?.toLowerCase().startsWith(`${kin} `)) : undefined)
      ?? mine.find((x) => x.name.toLowerCase().split(/\s+/).includes(n)) ?? mine.find((x) => x.name.toLowerCase().includes(n));
    if (!c?.matchedUserId) { problems.push(`${raw} isn't one of your contacts on i-persons`); continue; }
    // The other side's `plan` scope: they let my twin send planning requests to theirs.
    if (!(await granted(db, c.matchedUserId, me, 'plan'))) { problems.push(`your twins aren't connected with ${c.name} (or they turned off planning requests)`); continue; }
    if (!found.some((f) => f.userId === c.matchedUserId)) found.push({ userId: c.matchedUserId, name: c.name });
  }
  return { found, problems };
}

/** §7: max 5 pending plans per user, max 2 pending between the same two people; dates must make sense. */
export async function planRefusal(db: Db, me: string, input: PlanInput, now = new Date()): Promise<string | null> {
  if (input.date_to < input.date_from) return 'date_to is before date_from';
  if ((new Date(`${input.date_to}T00:00Z`).getTime() - new Date(`${input.date_from}T00:00Z`).getTime()) / 86_400_000 > 21) return 'Pick a range of at most 3 weeks.';
  if (input.date_to < now.toISOString().slice(0, 10)) return 'Those dates are in the past.';
  const { found, problems } = await resolveParticipants(db, me, input.contacts);
  if (problems.length) return `Can't plan: ${problems.join('; ')}.`;
  if (!found.length) return 'Name at least one connected contact.';
  const [mineOpen] = await db.select({ n: sql<number>`count(*)::int` }).from(planSessions)
    .where(and(eq(planSessions.creatorId, me), inArray(planSessions.status, [...OPEN])));
  if ((mineOpen?.n ?? 0) >= MAX_PENDING_PER_USER) return `You already have ${MAX_PENDING_PER_USER} plans waiting for answers. Let some finish first.`;
  for (const f of found) {
    const [between] = await db.select({ n: sql<number>`count(distinct ${planSessions.id})::int` }).from(planSessions)
      .innerJoin(planParticipants, eq(planParticipants.sessionId, planSessions.id))
      .where(and(inArray(planSessions.status, [...OPEN]), or(
        and(eq(planSessions.creatorId, me), eq(planParticipants.userId, f.userId)),
        and(eq(planSessions.creatorId, f.userId), eq(planParticipants.userId, me)),
      )));
    if ((between?.n ?? 0) >= MAX_PENDING_PER_PAIR) return `There are already ${MAX_PENDING_PER_PAIR} plans waiting between you and ${f.name}.`;
  }
  return null;
}

export function planSummary(input: PlanInput, names: string[]): string {
  const what = input.type === 'custom' && input.title ? input.title : PLAN_TYPE_LABELS[input.type].toLowerCase();
  const who = joinAnd(names.map((n) => `${n}'s`));
  const when = input.date_from === input.date_to ? input.date_from : `${input.date_from} to ${input.date_to}`;
  const dur = input.duration_minutes % 60 === 0 ? `${input.duration_minutes / 60} hour${input.duration_minutes === 60 ? '' : 's'}` : `${input.duration_minutes} min`;
  return `Ask ${who} i-person${names.length > 1 ? 's' : ''} for ${what}, ${when}${input.time_of_day !== 'any' ? ` (${input.time_of_day})` : ''}, ${dur}${input.area ? `, ${input.area}` : ''}?`;
}

// --- one person's side: free slots from their own calendar, rules and working hours ---

async function sideStarts(db: Db, userId: string, q: SlotQuery, now: Date): Promise<{ tz: string; starts: Date[] }> {
  const u = await userRow(db, userId);
  const ip = await ipersonOf(db, userId);
  if (!ip) return { tz: u.timezone, starts: [] };
  const from = new Date(`${q.dateFrom}T00:00:00Z`).getTime() - 86_400_000;
  const to = new Date(`${q.dateTo}T00:00:00Z`).getTime() + 2 * 86_400_000;
  // Every calendar the twin knows: the built-in one and imported Outlook/Google events.
  const busy = await db.select({ start: calendarEvents.startsAt, end: calendarEvents.endsAt }).from(calendarEvents)
    .where(and(eq(calendarEvents.ipersonId, ip), lt(calendarEvents.startsAt, new Date(to)), gt(calendarEvents.endsAt, new Date(from))));
  const rules = await activeRules(db, ip);
  const hours = (await listFacts(db, ip, { limit: 100 })).find((f) => /working_?hours|work_hours|office_hours/.test(f.key))?.value;
  return { tz: u.timezone, starts: freeStarts({ tz: u.timezone, q, busy, rules, workingHours: parseWorkingHours(hours), now }) };
}

const queryOf = (s: Session): SlotQuery => ({ dateFrom: s.dateFrom, dateTo: s.dateTo, durationMin: s.durationMin, timeOfDay: s.timeOfDay as TimeOfDay, type: s.type as PlanType });

/**
 * B's twin, privately: B's free times ∩ A's shared free times (only if A granted availability to B),
 * ≤3 candidates. Only these instants leave B's side.
 */
export async function candidatesFor(db: Db, s: Session, participantId: string, now = new Date(), q = queryOf(s)): Promise<Date[]> {
  const b = await sideStarts(db, participantId, q, now);
  let starts = b.starts;
  if (await granted(db, s.creatorId, participantId, 'availability')) starts = intersect([starts, (await sideStarts(db, s.creatorId, q, now)).starts]);
  return pickCandidates(starts, b.tz, 3);
}

// --- the protocol ---

/** Runs after the creator approved "Ask Sami's i-person for coffee…?" (tool plan_with_contacts). */
export async function startPlan(deps: AppDeps, creatorId: string, input: PlanInput, now = new Date()) {
  const { db } = deps;
  const refusal = await planRefusal(db, creatorId, input, now);
  if (refusal) throw new PlanError(refusal);
  const { found } = await resolveParticipants(db, creatorId, input.contacts);
  const [s] = await db.insert(planSessions).values({
    creatorId, type: input.type, title: input.title ?? null, durationMin: input.duration_minutes, dateFrom: input.date_from, dateTo: input.date_to,
    timeOfDay: input.time_of_day, area: input.area ?? null, budget: input.budget ?? null, note: input.note ?? null, autoConfirm: input.auto_confirm,
    status: 'sent', expiresAt: new Date(now.getTime() + PLAN_TTL_MS),
  }).returning();
  for (const f of found) await db.insert(planParticipants).values({ sessionId: s!.id, userId: f.userId });
  void logCall({ service: 'Twin-to-twin', what: `plan sent to ${found.map((f) => f.name).join(', ')}'s i-person: ${planLabel(s!).toLowerCase()} ${s!.dateFrom} → ${s!.dateTo}` }, { userId: creatorId });
  const loaded = (await loadPlan(db, s!.id))!;
  for (const p of loaded.participants) await requestTimes(deps, loaded.session, p, now);
  await maybeCompose(deps, s!.id, now);
  return { session_id: s!.id, with: found.map((f) => f.name), status: 'sent' };
}

/** Request A → B. With B's availability scope B's twin answers at once; otherwise B is asked first. */
async function requestTimes(deps: AppDeps, s: Session, p: Participant, now: Date) {
  const { db } = deps;
  if (await granted(db, p.userId, s.creatorId, 'availability')) {
    const c = await candidatesFor(db, s, p.userId, now);
    await setParticipant(db, p.id, { status: 'shared', candidates: c.map((d) => d.toISOString()), respondedAt: now });
    void logCall({ service: 'Twin-to-twin', what: `${await firstName(db, p.userId)}'s i-person shared ${c.length} free times (free/busy only, no calendar details)` }, { userId: p.userId });
    return;
  }
  await setParticipant(db, p.id, { status: 'asked' });
  const who = await firstName(db, s.creatorId);
  const range = s.dateFrom === s.dateTo ? `on ${s.dateFrom}` : `between ${s.dateFrom} and ${s.dateTo}`;
  await systemCard(deps, p.userId, {
    kind: 'share_times', args: { session_id: s.id, participant_id: p.id }, ttlMs: cardTtl(s), block: true,
    summary: `${who}'s i-person asks for ${planLabel(s).toLowerCase()} ${range}${s.area ? `, ${s.area}` : ''}. Share 3 possible times? (Only free times, never what's in your calendar.)${quoteNote(who, s.note)}`,
    template: { name: TWIN_TEMPLATES.plan, params: [who, planLabel(s).toLowerCase(), range] },
  });
}

/** B said yes to sharing times (card). */
export async function shareTimes(deps: AppDeps, userId: string, participantId: string, now = new Date()) {
  const { db } = deps;
  const [p] = await db.select().from(planParticipants).where(eq(planParticipants.id, participantId));
  if (!p || p.userId !== userId || p.status !== 'asked') return { error: 'this request is no longer open' };
  const plan = await loadPlan(db, p.sessionId);
  if (!plan || plan.session.status !== 'sent') return { error: 'this plan is no longer open' };
  const c = await candidatesFor(db, plan.session, userId, now);
  await setParticipant(db, p.id, { status: 'shared', candidates: c.map((d) => d.toISOString()), respondedAt: now });
  void logCall({ service: 'Twin-to-twin', what: `shared ${c.length} free times (free/busy only, no calendar details)` }, { userId });
  await maybeCompose(deps, p.sessionId, now);
  return { shared_times: c.length };
}

async function llmFor(deps: AppDeps, userId: string) {
  if (deps.billing && !(await hasCredit(deps.db, userId))) return undefined;
  return tagLlm(deps.billing ? meteredLlm(deps.llm, deps.db, userId, config.META_LLM_MODEL) : deps.llm, { userId, purpose: 'Twin-to-twin: find places' });
}

/**
 * A's runtime, once every participant answered: intersect everyone's candidates with A's own calendar,
 * find places, and ask A "Send these options?".
 */
export async function maybeCompose(deps: AppDeps, sessionId: string, now = new Date()) {
  const { db } = deps;
  const plan = await loadPlan(db, sessionId);
  if (!plan || plan.session.status !== 'sent') return;
  const { session: s, participants } = plan;
  if (participants.some((p) => p.status === 'pending' || p.status === 'asked')) return;
  const sharing = participants.filter((p) => p.status === 'shared');
  const names = new Map<string, string>();
  for (const p of participants) names.set(p.userId, await contactNameFor(db, s.creatorId, p.userId));
  if (!sharing.length) {
    await setSession(db, s.id, { status: 'declined', endReason: 'nobody shared times' });
    await twinSays(deps, s.creatorId, `${joinAnd(participants.map((p) => names.get(p.userId)!))} can't make ${planLabel(s).toLowerCase()} in that period.`);
    return;
  }
  const mine = await sideStarts(db, s.creatorId, queryOf(s), now);
  const common = intersect([...sharing.map((p) => (p.candidates as string[]).map((x) => new Date(x))), mine.starts]).slice(0, 3);
  if (!common.length) {
    await setSession(db, s.id, { status: 'cancelled', endReason: 'no common time' });
    await twinSays(deps, s.creatorId, `I couldn't find a time for ${planLabel(s).toLowerCase()} that works for you and ${joinAnd(sharing.map((p) => names.get(p.userId)!))} between ${s.dateFrom} and ${s.dateTo}. Want to try other dates?`);
    return;
  }
  void logCall({ service: 'Twin-to-twin', what: `compared free times of ${sharing.length + 1} people → ${common.length} common slot(s)` }, { userId: s.creatorId });
  let pos = 0;
  for (const c of common) {
    await db.insert(planOptions).values({ sessionId: s.id, kind: 'slot', value: { start: c.toISOString(), end: new Date(c.getTime() + s.durationMin * 60_000).toISOString() }, source: 'calendar', position: pos++ });
  }
  const places: Place[] = [];
  if (PLACE_TYPES.includes(s.type as PlanType)) {
    // Only what each side allowed to share (preferences scope + ticked facts), plus the creator's own facts.
    const constraints: string[] = [];
    for (const p of sharing) for (const f of await sharedPreferences(db, p.userId, s.creatorId)) constraints.push(`${f.key.replace(/_/g, ' ')}: ${f.value}`);
    const ip = await ipersonOf(db, s.creatorId);
    if (ip) for (const f of (await listFacts(db, ip, { category: 'preference', limit: 10 }))) constraints.push(`${f.key.replace(/_/g, ' ')}: ${f.value}`);
    const llm = await llmFor(deps, s.creatorId);
    const found = llm ? await findPlaces(db, llm, { type: s.type as PlanType, area: s.area ?? undefined, timezone: mine.tz, constraints, budget: s.budget ?? undefined, demo: (await userRow(db, s.creatorId)).accountKind === 'demo' }).catch(() => ({ places: [] as Place[] })) : { places: [] as Place[] };
    places.push(...found.places);
  }
  for (const p of places) {
    await db.insert(planOptions).values({ sessionId: s.id, kind: 'place', value: p, source: p.partner ? 'partner' : 'web', link: p.url ?? null, position: pos++ });
  }
  await setSession(db, s.id, { status: 'negotiating' });
  const withWho = joinAnd(sharing.map((p) => names.get(p.userId)!));
  const dropped = participants.filter((p) => p.status !== 'shared').map((p) => names.get(p.userId)!);
  await systemCard(deps, s.creatorId, {
    kind: 'send_options', args: { session_id: s.id }, ttlMs: cardTtl(s),
    summary: `${planLabel(s)} with ${withWho}: ${joinOr(common.map((c) => fmtSlot(c, mine.tz)))}${places.length ? ` at ${joinOr(places.map(placeName))}` : ''}. Send to ${withWho}?${dropped.length ? ` (${joinAnd(dropped)} can't make it.)` : ''}`,
  });
}

/** The creator's name for a participant as it appears in the creator's contacts (falls back to their first name). */
async function contactNameFor(db: Db, owner: string, other: string) {
  const [c] = await db.select({ name: contacts.name }).from(contacts).where(and(eq(contacts.userId, owner), eq(contacts.matchedUserId, other)));
  return c?.name ?? (await firstName(db, other));
}

/** Creator removes an option before sending (web). */
export async function removeOption(db: Db, userId: string, sessionId: string, optionId: string, removed: boolean) {
  const plan = await loadPlan(db, sessionId);
  if (!plan || plan.session.creatorId !== userId || plan.session.status !== 'negotiating' || plan.participants.some((p) => p.status === 'invited' || p.status === 'accepted')) {
    throw new PlanError('Options can only be changed before they are sent.');
  }
  const opt = plan.options.find((o) => o.id === optionId);
  if (!opt) throw new PlanError('not_found');
  if (removed && opt.kind === 'slot' && plan.options.filter((o) => o.kind === 'slot' && !o.removed && o.id !== optionId).length === 0) throw new PlanError('Keep at least one time.');
  await db.update(planOptions).set({ removed }).where(eq(planOptions.id, optionId));
}

/** A approved "Send to Sami?": each participant gets a card to pick a time and a place. */
export async function sendOptions(deps: AppDeps, userId: string, sessionId: string) {
  const { db } = deps;
  const plan = await loadPlan(db, sessionId);
  if (!plan || plan.session.creatorId !== userId || plan.session.status !== 'negotiating') return { error: 'this plan is no longer open' };
  const { session: s } = plan;
  const slots = plan.options.filter((o) => o.kind === 'slot' && !o.removed);
  const places = plan.options.filter((o) => o.kind === 'place' && !o.removed);
  const who = await firstName(db, s.creatorId);
  let sent = 0;
  for (const p of plan.participants.filter((x) => x.status === 'shared')) {
    const tz = (await userRow(db, p.userId)).timezone;
    await setParticipant(db, p.id, { status: 'invited' });
    const times = slots.map((o) => fmtSlot(new Date((o.value as { start: string }).start), tz));
    const others = plan.participants.filter((x) => x.status === 'shared').length - 1;
    await systemCard(deps, p.userId, {
      kind: 'choose', args: { session_id: s.id, participant_id: p.id }, ttlMs: cardTtl(s), block: true,
      summary: `${who}'s i-person proposes ${planLabel(s).toLowerCase()}${others > 0 ? ` (with ${others} other${others > 1 ? 's' : ''})` : ''}: ${joinOr(times)}${places.length ? ` at ${joinOr(places.map((o) => placeName(o.value as Place)))}` : ''}. Approve takes the first time${places.length ? ' and place' : ''}; pick others, suggest another time or decline on the Contacts page.${quoteNote(who, s.note)}`,
      template: { name: TWIN_TEMPLATES.plan, params: [who, planLabel(s).toLowerCase(), times.join(', ')] },
    });
    sent++;
  }
  return { sent_to: sent };
}

export type Answer = { slot_option_ids: string[]; place_option_id?: string } | { decline: true } | { counter: { date_from: string; date_to: string; time_of_day?: TimeOfDay } };

/** B's answer: pick (times + place), decline, or one counter-proposal (1:1 plans). From a card or the web. */
export async function answerPlan(deps: AppDeps, userId: string, sessionId: string, answer: Answer, opts: { viaCard?: boolean; now?: Date } = {}) {
  const { db } = deps;
  const now = opts.now ?? new Date();
  const plan = await loadPlan(db, sessionId);
  const p = plan?.participants.find((x) => x.userId === userId);
  if (!plan || !p || plan.session.status !== 'negotiating' || p.status !== 'invited') throw new PlanError('This plan is no longer waiting for your answer.');
  const { session: s } = plan;
  const ip = await ipersonOf(db, userId);
  // An answer on the page settles the card too (the tap was the yes or the no).
  if (!opts.viaCard && ip) await closeCards(db, s.id, 'done', { kinds: ['choose'], ipersonId: ip });

  if ('decline' in answer) {
    await setParticipant(db, p.id, { status: 'declined', respondedAt: now });
  } else if ('counter' in answer) {
    if (s.counterUsed || plan.participants.length > 1) throw new PlanError(plan.participants.length > 1 ? 'Group plans can’t be countered; pick or decline.' : 'Only one counter-proposal per plan.');
    const q = { ...queryOf(s), dateFrom: answer.counter.date_from, dateTo: answer.counter.date_to, timeOfDay: answer.counter.time_of_day ?? (s.timeOfDay as TimeOfDay) };
    if (!ISO_DATE.test(q.dateFrom) || !ISO_DATE.test(q.dateTo) || q.dateTo < q.dateFrom) throw new PlanError('Pick valid dates.');
    // B proposed these times themself (their yes); A's side keeps only those free for A.
    const mine = pickCandidates((await sideStarts(db, userId, q, now)).starts, (await userRow(db, userId)).timezone, 3);
    const fits = intersect([mine, (await sideStarts(db, s.creatorId, q, now)).starts]);
    if (!fits.length) throw new PlanError('None of your free times in that range works for them. Try other dates.');
    await db.update(planOptions).set({ removed: true }).where(and(eq(planOptions.sessionId, s.id), eq(planOptions.kind, 'slot')));
    const ids: string[] = [];
    for (const [i, c] of fits.entries()) {
      const [o] = await db.insert(planOptions).values({ sessionId: s.id, kind: 'slot', value: { start: c.toISOString(), end: new Date(c.getTime() + s.durationMin * 60_000).toISOString() }, source: 'counter', position: 100 + i }).returning();
      ids.push(o!.id);
    }
    const place = plan.options.find((o) => o.kind === 'place' && !o.removed);
    await setSession(db, s.id, { counterUsed: true, dateFrom: q.dateFrom, dateTo: q.dateTo, timeOfDay: q.timeOfDay, expiresAt: new Date(now.getTime() + PLAN_TTL_MS) });
    await setParticipant(db, p.id, { status: 'accepted', chosenSlotIds: ids, chosenPlaceId: place?.id ?? null, respondedAt: now });
  } else {
    const live = plan.options.filter((o) => !o.removed);
    const slotIds = [...new Set(answer.slot_option_ids)];
    if (!slotIds.length || slotIds.some((id) => !live.some((o) => o.id === id && o.kind === 'slot'))) throw new PlanError('Pick one of the proposed times.');
    if (plan.participants.length === 1 && slotIds.length > 1) throw new PlanError('Pick one time.');
    const places = live.filter((o) => o.kind === 'place');
    if (answer.place_option_id && !places.some((o) => o.id === answer.place_option_id)) throw new PlanError('Pick one of the proposed places.');
    await setParticipant(db, p.id, { status: 'accepted', chosenSlotIds: slotIds, chosenPlaceId: answer.place_option_id ?? places[0]?.id ?? null, respondedAt: now });
  }
  void logCall({ service: 'Twin-to-twin', what: `${await firstName(db, userId)} answered the plan (${'decline' in answer ? 'declined' : 'counter' in answer ? 'counter-proposal' : 'picked a time'})` }, { userId });
  await afterAnswers(deps, s.id, now);
  return { status: 'answered' };
}

/** The time most people picked (ties: earliest), and who can't make it. */
function decide(plan: Loaded) {
  const accepted = plan.participants.filter((p) => p.status === 'accepted');
  const votes = new Map<string, number>();
  for (const p of accepted) for (const id of p.chosenSlotIds as string[]) votes.set(id, (votes.get(id) ?? 0) + 1);
  const slots = plan.options.filter((o) => o.kind === 'slot' && !o.removed)
    .sort((a, b) => (votes.get(b.id) ?? 0) - (votes.get(a.id) ?? 0) || (a.value as { start: string }).start.localeCompare((b.value as { start: string }).start));
  const slot = slots[0] && votes.get(slots[0].id) ? slots[0] : undefined;
  const placeVotes = new Map<string, number>();
  for (const p of accepted) if (p.chosenPlaceId) placeVotes.set(p.chosenPlaceId, (placeVotes.get(p.chosenPlaceId) ?? 0) + 1);
  const place = plan.options.filter((o) => o.kind === 'place' && !o.removed).sort((a, b) => (placeVotes.get(b.id) ?? 0) - (placeVotes.get(a.id) ?? 0) || a.position - b.position)[0];
  const going = accepted.filter((p) => slot && (p.chosenSlotIds as string[]).includes(slot.id));
  const out = plan.participants.filter((p) => !going.includes(p) && p.status !== 'dropped');
  return { slot, place, going, out };
}

/** When every participant answered: "Lea can't make it — go ahead with Sami?", or "Book it?" (or auto-confirm). */
export async function afterAnswers(deps: AppDeps, sessionId: string, now = new Date()) {
  const { db } = deps;
  const plan = await loadPlan(db, sessionId);
  if (!plan || plan.session.status !== 'negotiating') return;
  if (plan.participants.some((p) => p.status === 'invited')) return;
  const { session: s } = plan;
  const tz = (await userRow(db, s.creatorId)).timezone;
  const nameOf = async (p: Participant) => contactNameFor(db, s.creatorId, p.userId);
  const { slot, place, going, out } = decide(plan);
  if (!going.length || !slot) {
    await setSession(db, s.id, { status: 'declined', endReason: 'declined' });
    await twinSays(deps, s.creatorId, `${joinAnd(await Promise.all(plan.participants.map(nameOf)))} can't make ${planLabel(s).toLowerCase()} this time.`, { whatsapp: true });
    return;
  }
  const when = fmtSlot(new Date((slot.value as { start: string }).start), tz);
  const where = place ? ` at ${placeName(place.value as Place)}` : '';
  if (out.length) {
    if (await openCard(db, s.id, 'proceed_without')) return;
    await systemCard(deps, s.creatorId, {
      kind: 'proceed_without', args: { session_id: s.id }, ttlMs: cardTtl(s),
      summary: `${joinAnd(await Promise.all(out.map(nameOf)))} can't make it. Go ahead with ${joinAnd(await Promise.all(going.map(nameOf)))} on ${when}${where}?`,
    });
    return;
  }
  await setSession(db, s.id, { status: 'awaiting_confirmation' });
  if (s.autoConfirm) {
    await bookPlan(deps, s.id, now);
    return;
  }
  await systemCard(deps, s.creatorId, {
    kind: 'confirm', args: { session_id: s.id }, ttlMs: cardTtl(s),
    summary: `${joinAnd(await Promise.all(going.map(nameOf)))} ${going.length > 1 ? 'are' : 'is'} in: ${planLabel(s).toLowerCase()} on ${when}${where}. Book it?`,
  });
}

/** A approved "go ahead without Lea": those who can't make it are dropped, then it's A's confirm. */
export async function proceedWithout(deps: AppDeps, userId: string, sessionId: string, now = new Date()) {
  const { db } = deps;
  const plan = await loadPlan(db, sessionId);
  if (!plan || plan.session.creatorId !== userId || plan.session.status !== 'negotiating') return { error: 'this plan is no longer open' };
  const { out } = decide(plan);
  for (const p of out) await setParticipant(db, p.id, { status: 'dropped' });
  await setSession(db, sessionId, { status: 'awaiting_confirmation' });
  // Going ahead without them IS the creator's confirmation of the remaining plan.
  return bookPlan(deps, sessionId, now);
}

/** A confirmed: everyone involved said yes. Calendars, place, confirmations. */
export async function bookPlan(deps: AppDeps, sessionId: string, now = new Date()) {
  const { db } = deps;
  const plan = await loadPlan(db, sessionId);
  if (!plan || plan.session.status !== 'awaiting_confirmation') return { error: 'this plan is not ready to book' };
  const { session: s } = plan;
  const { slot, place, going } = decide(plan);
  // Belt and braces: booking needs the creator's confirmation (this call) and every remaining participant's yes.
  if (!slot || !going.length || plan.participants.some((p) => p.status !== 'accepted' && p.status !== 'dropped' && p.status !== 'declined' && p.status !== 'expired')) {
    return { error: 'not everyone said yes' };
  }
  const start = new Date((slot.value as { start: string }).start);
  const end = new Date((slot.value as { end: string }).end);
  const pl = place?.value as Place | undefined;
  const people = [s.creatorId, ...going.map((p) => p.userId)];
  const location = pl ? `${pl.name}${pl.address ? `, ${pl.address}` : ''}`.slice(0, 200) : s.area ?? undefined;
  for (const uid of people) {
    const ip = await ipersonOf(db, uid);
    if (!ip) continue;
    const others = await Promise.all(people.filter((x) => x !== uid).map((x) => contactNameFor(db, uid, x)));
    const title = `${planLabel(s)} with ${joinAnd(others)}`.slice(0, 200);
    await db.insert(calendarEvents).values({ ipersonId: ip, title, startsAt: start, endsAt: end, location: location ?? null });
    void logCall({ service: 'Calendar', what: `"${title}" added to ${await firstName(db, uid)}'s calendar` }, { userId: uid });
    await sendIcs(db, uid, ip, { title, start, end, location, uid: `${s.id}@i-persons.com` });
  }
  await setSession(db, s.id, { status: 'booked', bookedStart: start, bookedEnd: end, bookedPlaceId: place?.id ?? null });
  void logCall({ service: 'Twin-to-twin', what: `booked for ${people.length} people, both sides said yes${pl ? ` — ${pl.name}` : ''}` }, { userId: s.creatorId });
  await closeCards(db, s.id, 'expired');

  // The place: a partner venue that takes reservations gets a request it accepts or declines; otherwise a hand-off link.
  let placeLine = '';
  if (pl?.partner && pl.offer_id && pl.accepts_reservations) {
    const [offer] = await db.execute<{ partner_id: string }>(sql`select partner_id from partner_offers where id = ${pl.offer_id}`).then((r) => r.rows);
    if (offer) {
      const [req] = await db.insert(partnerRequests).values({
        partnerId: offer.partner_id, offerId: pl.offer_id, userId: s.creatorId, kind: 'reservation',
        payload: { slot: start.toISOString(), duration_minutes: s.durationMin, party_size: people.length, plan_session_id: s.id },
      }).returning();
      await emit(db, offer.partner_id, 'reservation.requested', { request_id: req!.id, twin_id: await ensureTwin(db, offer.partner_id, s.creatorId), offer_id: pl.offer_id, slot: start.toISOString(), duration_minutes: s.durationMin, party_size: people.length });
      placeLine = ` I asked ${pl.name} for a table; I'll tell you when they answer.`;
    }
  } else if (pl?.reservation_url || pl?.url) {
    placeLine = ` Reserve or check the place here: ${pl.reservation_url ?? pl.url}`;
  }
  for (const uid of people) {
    const tz = (await userRow(db, uid)).timezone;
    const others = await Promise.all(people.filter((x) => x !== uid).map((x) => contactNameFor(db, uid, x)));
    const line = `${planLabel(s)} with ${joinAnd(others)} is set: ${fmtSlot(start, tz)}${pl ? ` at ${pl.name}` : ''}.`;
    await twinSays(deps, uid, `${line}${uid === s.creatorId ? placeLine : pl?.url ? ` Place: ${pl.url}` : ''}`, { whatsapp: true, template: { name: TWIN_TEMPLATES.confirmed, params: [planLabel(s), joinAnd(others), fmtSlot(start, tz), pl?.name ?? s.area ?? '-'] } });
  }
  return { booked: true, start: start.toISOString(), place: pl?.name ?? null, with: going.length };
}

/** Outlook/Google are connected read-only: an .ics invite by email puts the event in that calendar too. */
async function sendIcs(db: Db, userId: string, ipersonId: string, ev: { title: string; start: Date; end: Date; location?: string; uid: string }) {
  if (!config.SMTP_URL) return;
  const boxes = await db.select({ config: connections.config }).from(connections).where(eq(connections.ipersonId, ipersonId));
  if (!boxes.some((b) => grants(b.config as MailConfig, 'calendar'))) return;
  const u = await userRow(db, userId);
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (t: string) => t.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//i-persons//twin-to-twin//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(ev.start)}`, `DTEND:${stamp(ev.end)}`, `SUMMARY:${esc(ev.title)}`, ...(ev.location ? [`LOCATION:${esc(ev.location)}`] : []), `ORGANIZER;CN=i-persons:mailto:${config.INVITE_FROM}`,
    `ATTENDEE;CN=${esc(u.name)};RSVP=FALSE:mailto:${u.email}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  await mailTransport(config.SMTP_URL).sendMail({
    from: config.SMTP_FROM, to: u.email, subject: ev.title, text: `${ev.title}\n${ev.start.toUTCString()}${ev.location ? `\n${ev.location}` : ''}\n\n— your i-person`,
    icalEvent: { method: 'REQUEST', content: ics },
  }).catch(() => {});
}

/** The creator called it off (declined a send/confirm card, or the web Cancel). */
export async function cancelPlan(deps: AppDeps, userId: string, sessionId: string, reason = 'cancelled') {
  const { db } = deps;
  const plan = await loadPlan(db, sessionId);
  if (!plan || plan.session.creatorId !== userId || !(ACTIVE as readonly string[]).includes(plan.session.status)) return;
  await setSession(db, sessionId, { status: 'cancelled', endReason: reason });
  await closeCards(db, sessionId, 'expired');
  const who = await firstName(db, userId);
  for (const p of plan.participants.filter((x) => x.status === 'invited' || x.status === 'accepted')) {
    await twinSays(deps, p.userId, `${who} called off the ${planLabel(plan.session).toLowerCase()} plan.`);
  }
}

/** Disconnect / block applies at once: open plans between the two are cancelled. */
connectionEnded.push(async (deps: AppDeps, conn: Conn) => {
  const open = await deps.db.selectDistinct({ id: planSessions.id }).from(planSessions).innerJoin(planParticipants, eq(planParticipants.sessionId, planSessions.id))
    .where(and(inArray(planSessions.status, [...ACTIVE]), or(
      and(eq(planSessions.creatorId, conn.requesterId), eq(planParticipants.userId, conn.recipientId)),
      and(eq(planSessions.creatorId, conn.recipientId), eq(planParticipants.userId, conn.requesterId)),
    )));
  for (const s of open) {
    await setSession(deps.db, s.id, { status: 'cancelled', endReason: 'connection ended' });
    await closeCards(deps.db, s.id, 'expired');
  }
});

/** §5b.7: plans expire after 48 hours; one reminder after 24 hours. Run every few minutes. */
export async function planTick(deps: AppDeps, now = new Date()) {
  const { db } = deps;
  const due = await db.select().from(planSessions).where(and(inArray(planSessions.status, [...OPEN]), lt(planSessions.expiresAt, now)));
  for (const s of due) {
    await setSession(db, s.id, { status: 'expired', endReason: 'no answer in 48 hours' });
    await db.update(planParticipants).set({ status: 'expired' }).where(and(eq(planParticipants.sessionId, s.id), inArray(planParticipants.status, ['pending', 'asked', 'invited'])));
    await closeCards(db, s.id, 'expired');
    await twinSays(deps, s.creatorId, `Your ${planLabel(s).toLowerCase()} plan expired: not everyone answered within 48 hours.`);
  }
  const remind = await db.select().from(planSessions).where(and(inArray(planSessions.status, ['sent', 'negotiating']), lt(planSessions.createdAt, new Date(now.getTime() - REMIND_AFTER_MS)), sql`${planSessions.remindedAt} is null`));
  for (const s of remind) {
    await setSession(db, s.id, { remindedAt: now });
    const waiting = await db.select().from(planParticipants).where(and(eq(planParticipants.sessionId, s.id), inArray(planParticipants.status, ['asked', 'invited'])));
    const who = await firstName(db, s.creatorId);
    for (const p of waiting) {
      await reach(deps, p.userId, { text: `Reminder: ${who}'s i-person is waiting for your answer about ${planLabel(s).toLowerCase()}. Open i-persons → Contacts.`, template: { name: TWIN_TEMPLATES.plan, params: [who, planLabel(s).toLowerCase(), 'reminder'] }, subject: `Reminder from ${who}'s i-person` });
    }
  }
}

// --- views (never another person's calendar, facts or contacts) ---

/** One plan as `userId` sees it: their role, the options in their timezone, the note as untrusted text. */
export async function planView(db: Db, userId: string, sessionId: string) {
  const plan = await loadPlan(db, sessionId);
  if (!plan) return undefined;
  const { session: s, participants, options } = plan;
  const me = participants.find((p) => p.userId === userId);
  const creator = s.creatorId === userId;
  if (!creator && !me) return undefined;
  const tz = (await userRow(db, userId)).timezone;
  const live = options.filter((o) => !o.removed || creator);
  const slotLabel = (o: Option) => fmtSlot(new Date((o.value as { start: string }).start), tz);
  const editable = creator && s.status === 'negotiating' && !participants.some((p) => p.status === 'invited' || p.status === 'accepted');
  return {
    id: s.id, type: s.type, title: planLabel(s), status: s.status, role: creator ? 'creator' : 'participant',
    duration_minutes: s.durationMin, date_from: s.dateFrom, date_to: s.dateTo, time_of_day: s.timeOfDay, area: s.area, budget: s.budget,
    // Participants see the creator (their contact) only, never the other invitees' names.
    from: creator ? null : await contactNameFor(db, userId, s.creatorId),
    with: creator ? await Promise.all(participants.map(async (p) => ({ name: await contactNameFor(db, userId, p.userId), status: p.status }))) : undefined,
    others: creator ? undefined : participants.length - 1,
    note: s.note, note_from_other: !creator && Boolean(s.note),
    my_status: me?.status ?? null,
    can_answer: Boolean(me && me.status === 'invited' && s.status === 'negotiating'),
    can_counter: Boolean(me && me.status === 'invited' && !s.counterUsed && participants.length === 1),
    can_edit_options: editable,
    slots: live.filter((o) => o.kind === 'slot').map((o) => ({ id: o.id, label: slotLabel(o), removed: o.removed, source: o.source })),
    places: live.filter((o) => o.kind === 'place').map((o) => ({ id: o.id, ...(o.value as Place), removed: o.removed })),
    booked: s.status === 'booked' && s.bookedStart ? { when: fmtSlot(s.bookedStart, tz), place: (options.find((o) => o.id === s.bookedPlaceId)?.value as Place | undefined)?.name ?? null } : null,
    expires_at: s.expiresAt.toISOString(),
  };
}

/** Plans I'm part of (latest first). */
export async function myPlans(db: Db, userId: string, limit = 30) {
  const asParticipant = db.select({ id: planParticipants.sessionId }).from(planParticipants).where(eq(planParticipants.userId, userId));
  const rows = await db.select({ id: planSessions.id }).from(planSessions)
    .where(or(eq(planSessions.creatorId, userId), inArray(planSessions.id, asParticipant))).orderBy(desc(planSessions.createdAt)).limit(limit);
  return (await Promise.all(rows.map((r) => planView(db, userId, r.id)))).filter(Boolean);
}

/** History with one person, for the contact sheet. */
export async function plansTogether(db: Db, me: string, other: string) {
  const ids = await db.selectDistinct({ id: planSessions.id }).from(planSessions).innerJoin(planParticipants, eq(planParticipants.sessionId, planSessions.id))
    .where(or(and(eq(planSessions.creatorId, me), eq(planParticipants.userId, other)), and(eq(planSessions.creatorId, other), eq(planParticipants.userId, me))));
  const views = (await Promise.all(ids.map((r) => planView(db, me, r.id)))).filter((v): v is NonNullable<typeof v> => Boolean(v));
  return views.sort((a, b) => b.expires_at.localeCompare(a.expires_at)).map((v) => ({
    id: v.id, title: v.title, status: v.status, when: v.booked?.when ?? null, place: v.booked?.place ?? null, role: v.role,
    waiting_for_me: v.can_answer,
  }));
}

/** For the agent: plans, with the other side's note wrapped as untrusted content. */
export async function plansForAgent(db: Db, userId: string) {
  const views = await myPlans(db, userId, 10);
  return views.filter((v) => v && (ACTIVE as readonly string[]).includes(v.status) || v?.status === 'booked').slice(0, 8).map((v) => ({
    plan_id: v!.id, what: v!.title, status: v!.status, role: v!.role, from: v!.from ?? undefined,
    with: v!.with?.map((w) => `${w.name} (${w.status})`), times: v!.slots.filter((x) => !x.removed).map((x) => x.label),
    places: v!.places.filter((x) => !x.removed).map((x) => x.name), booked: v!.booked ?? undefined, waiting_for_you: v!.can_answer,
    // Words from another person: data, never instructions.
    note: v!.note && v!.note_from_other ? wrapUntrusted('another i-person', v!.note) : v!.note ?? undefined,
  }));
}
