import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { contacts, notifications, planParticipants, planSessions, twinConnections } from '../db/schema.ts';
import type { AppDeps } from '../http/deps.ts';
import { listFacts } from '../agent/memory.ts';
import { ipersonOf } from './activity.ts';
import { grantsOf, otherSide, sharedPreferences } from './connections.ts';
import { systemCard } from './notify.ts';
import { startPlan } from './plans.ts';

// §5d Proactive suggestions: only between connections where BOTH sides turned on `suggest`; at most one
// per user per week; always a card for the user, never sent to the other side without their yes.

const WEEK = 7 * 86_400_000;
const QUIET_MS = 3 * WEEK; // suggest someone not planned with for 3 weeks
const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - y.getTime()) / 86_400_000 + 1) / 7)}`;
};

async function lastPlanWith(db: Db, a: string, b: string): Promise<Date | null> {
  const [row] = await db.select({ at: planSessions.createdAt }).from(planSessions).innerJoin(planParticipants, eq(planParticipants.sessionId, planSessions.id))
    .where(or(and(eq(planSessions.creatorId, a), eq(planParticipants.userId, b)), and(eq(planSessions.creatorId, b), eq(planParticipants.userId, a))))
    .orderBy(desc(planSessions.createdAt)).limit(1);
  return row?.at ?? null;
}

/** Words both people care about: my preferences vs what the other side chose to share. */
async function sharedInterest(db: Db, me: string, other: string): Promise<string | null> {
  const theirs = await sharedPreferences(db, other, me);
  const ip = await ipersonOf(db, me);
  if (!ip || !theirs.length) return null;
  const mine = (await listFacts(db, ip, { category: 'preference', limit: 40 })).map((f) => `${f.key} ${f.value}`.toLowerCase());
  for (const t of theirs) {
    for (const w of `${t.key} ${t.value}`.toLowerCase().split(/[^a-zà-ÿ]+/).filter((x) => x.length >= 4)) {
      if (mine.some((m) => m.includes(w))) return w;
    }
  }
  return null;
}

/** One suggestion card at most per user per week. Returns the card, if one was made. */
export async function suggestPlans(deps: AppDeps, userId: string, now = new Date()) {
  const { db } = deps;
  const ip = await ipersonOf(db, userId);
  if (!ip) return undefined;
  const conns = await db.select().from(twinConnections).where(and(eq(twinConnections.status, 'active'), or(eq(twinConnections.requesterId, userId), eq(twinConnections.recipientId, userId))));
  const both = conns.filter((c) => grantsOf(c, userId).includes('suggest') && grantsOf(c, otherSide(c, userId)).includes('suggest') && grantsOf(c, otherSide(c, userId)).includes('plan'));
  if (!both.length) return undefined;
  const ranked: { c: typeof both[number]; last: Date | null }[] = [];
  for (const c of both) {
    const last = await lastPlanWith(db, userId, otherSide(c, userId));
    if (!last || now.getTime() - last.getTime() >= QUIET_MS) ranked.push({ c, last });
  }
  if (!ranked.length) return undefined;
  ranked.sort((a, b) => (a.last?.getTime() ?? 0) - (b.last?.getTime() ?? 0));
  const pick = ranked[0]!;
  const other = otherSide(pick.c, userId);
  const [contact] = await db.select({ name: contacts.name }).from(contacts).where(and(eq(contacts.userId, userId), eq(contacts.matchedUserId, other)));
  if (!contact) return undefined;
  // The weekly cap: the dedupe row is the claim, so two scans can't both send one.
  const [claimed] = await db.insert(notifications).values({ ipersonId: ip, kind: 'twin_suggestion', dedupeKey: `twin_suggest:${isoWeek(now)}`, payload: { connection_id: pick.c.id } })
    .onConflictDoNothing().returning();
  if (!claimed) return undefined;
  const interest = await sharedInterest(db, userId, other);
  const weeks = pick.last ? Math.round((now.getTime() - pick.last.getTime()) / WEEK) : null;
  const why = interest ? `You and ${contact.name} both like ${interest}.` : weeks ? `You haven't planned anything with ${contact.name} in ${weeks} weeks.` : `You haven't planned anything with ${contact.name} yet.`;
  return systemCard(deps, userId, {
    kind: 'suggest', args: { connection_id: pick.c.id }, ttlMs: 3 * 86_400_000,
    summary: `${why} Ask ${contact.name}'s i-person for a coffee next week?`,
  });
}

/** Approved suggestion: a coffee request for next week, through the normal protocol (the other side still decides). */
export async function acceptSuggestion(deps: AppDeps, userId: string, connectionId: string, now = new Date()) {
  const [c] = await deps.db.select().from(twinConnections).where(and(eq(twinConnections.id, connectionId), inArray(twinConnections.status, ['active'])));
  if (!c || (c.requesterId !== userId && c.recipientId !== userId)) return { error: 'no longer connected' };
  const [contact] = await deps.db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.userId, userId), eq(contacts.matchedUserId, otherSide(c, userId))));
  if (!contact) return { error: 'contact not found' };
  const day = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  const monday = (8 - now.getUTCDay()) % 7 || 7;
  return startPlan(deps, userId, { contacts: [contact.id], type: 'coffee', duration_minutes: 60, date_from: day(monday), date_to: day(monday + 4), time_of_day: 'any', auto_confirm: false }, now);
}
