import { asc, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { timeEstimates } from '../db/schema.ts';
import { real, realTwins } from './metrics.ts';

// Impact §1 "time given back": completed, approved actions × a conservative estimate per action type.
// Each action uses the estimate valid when it happened, so edits apply going forward only.

export const IMPACT_KINDS = ['calendar', 'email', 'travel_handoff', 'reorder_handoff', 'opportunity', 'twin_plan', 'partner_request', 'visitor_message'] as const;
export type ImpactKind = (typeof IMPACT_KINDS)[number];
export const IMPACT_LABELS: Record<ImpactKind, string> = {
  calendar: 'Calendar event booked', email: 'Email sent (per email)', travel_handoff: 'Hotel/flight hand-off with prefilled link',
  reorder_handoff: 'Shopping reorder hand-off', opportunity: 'Opportunity found and accepted', twin_plan: 'Twin-to-twin plan booked (per person)',
  partner_request: 'Partner request handled (interview, CV)', visitor_message: 'Visitor message handled by the twin',
};

export interface ImpactEvent { userId: string; kind: ImpactKind; at: Date; count: number }

/**
 * Completed, approved actions only (never proposals, declined or expired ones). Scope: one user, or every
 * real user (judges, demo accounts and admins excluded).
 */
export async function impactEvents(db: Db, opts: { userId?: string; since?: Date; until?: Date } = {}): Promise<ImpactEvent[]> {
  const since = opts.since ?? new Date(0);
  const until = opts.until ?? new Date('9999-01-01');
  const users = opts.userId ? sql`(select ${opts.userId}::uuid)` : real();
  const twins = opts.userId ? sql`(select id from ipersons where user_id = ${opts.userId}::uuid)` : realTwins();
  const rows = (await db.execute(sql`
    select i.user_id, case
        when a.tool = 'calendar_book' then 'calendar'
        when a.tool = 'send_email' then 'email'
        when a.tool = 'prepare_checkout' and a.args->>'provider' = 'amazon' then 'reorder_handoff'
        else 'travel_handoff' end kind,
      a.decided_at at_, case when a.tool = 'send_email' then greatest(jsonb_array_length(coalesce(a.args->'to', '[]'::jsonb)), 1) else 1 end n
    from actions a join ipersons i on i.id = a.iperson_id
    where a.status = 'done' and a.tool in ('calendar_book', 'send_email', 'prepare_checkout')
      and a.iperson_id in ${twins} and a.decided_at >= ${since} and a.decided_at < ${until}
    union all
    select r.user_id, 'partner_request', r.decided_at, 1 from partner_requests r
      where r.status = 'approved' and r.user_id in ${users} and r.decided_at >= ${since} and r.decided_at < ${until}
    union all
    select s.creator_id, 'twin_plan', s.updated_at, 1 from plan_sessions s
      where s.status = 'booked' and s.creator_id in ${users} and s.updated_at >= ${since} and s.updated_at < ${until}
    union all
    select p.user_id, 'twin_plan', s.updated_at, 1 from plan_participants p join plan_sessions s on s.id = p.session_id
      where s.status = 'booked' and p.status = 'accepted' and p.user_id in ${users} and s.updated_at >= ${since} and s.updated_at < ${until}    union all
    select i.user_id, 'visitor_message', m.created_at, 1 from visitor_messages m
      join visitor_conversations c on c.id = m.conversation_id join ipersons i on i.id = c.iperson_id
      where m.role = 'note' and c.iperson_id in ${twins} and m.created_at >= ${since} and m.created_at < ${until}
  `)).rows as { user_id: string; kind: ImpactKind; at_: Date | string; n: number | string }[];
  return rows.map((r) => ({ userId: r.user_id, kind: r.kind, at: new Date(r.at_), count: Number(r.n) }));
}

/** The estimates history, oldest first per kind. */
export const estimatesHistory = (db: Db) => db.select().from(timeEstimates).orderBy(asc(timeEstimates.kind), asc(timeEstimates.validFrom));

/** The estimate in effect for each kind right now (for the method page and the admin editor). */
export async function currentEstimates(db: Db) {
  const all = await estimatesHistory(db);
  const now = new Map<string, (typeof all)[number]>();
  for (const e of all) if (e.validFrom <= new Date()) now.set(e.kind, e);
  return IMPACT_KINDS.map((k) => ({ kind: k, label: IMPACT_LABELS[k], minutes: now.get(k)?.minutes ?? 0, justification: now.get(k)?.justification ?? '' }));
}

/** Minutes given back, total and per kind, using the estimate valid when each action happened. */
export async function timeGivenBack(db: Db, opts: { userId?: string; since?: Date; until?: Date } = {}) {
  const [events, history] = await Promise.all([impactEvents(db, opts), estimatesHistory(db)]);
  const minutesAt = (kind: string, at: Date) => {
    let m = 0;
    for (const e of history) if (e.kind === kind && e.validFrom <= at) m = e.minutes;
    return m;
  };
  const byKind: Record<string, { count: number; minutes: number }> = {};
  let minutes = 0;
  for (const ev of events) {
    const m = minutesAt(ev.kind, ev.at) * ev.count;
    minutes += m;
    const k = (byKind[ev.kind] ??= { count: 0, minutes: 0 });
    k.count += ev.count;
    k.minutes += m;
  }
  return { minutes: Math.round(minutes), byKind, events };
}

/** "about 1 h 20 min" */
export function formatMinutes(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
