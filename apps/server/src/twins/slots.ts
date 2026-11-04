import type { PlanType, TimeOfDay } from '@ipersons/shared';
import { parseLocal } from '../lib/time.ts';

// Free-slot computation for twin-to-twin planning (§5b.2). Pure code, run on each person's own side with
// their own calendar, rules and working hours: only the resulting candidate times ever leave it.

export interface Busy { start: Date; end: Date }
export interface SlotQuery { dateFrom: string; dateTo: string; durationMin: number; timeOfDay: TimeOfDay; type: PlanType }
export interface RuleLike { kind: 'do' | 'dont'; text: string }

const STEP = 30;
const MIN_NOTICE_MS = 2 * 3_600_000;
const MAX_DAYS = 21;

/** Minutes after local midnight when each kind of plan can happen. */
const TYPE_WINDOW: Record<PlanType, [number, number]> = {
  meeting: [9 * 60, 18 * 60], coffee: [8 * 60, 19 * 60], lunch: [12 * 60, 14 * 60 + 30], dinner: [19 * 60, 22 * 60 + 30],
  sport: [7 * 60, 21 * 60], walk: [8 * 60, 20 * 60], custom: [9 * 60, 21 * 60],
};
const TIME_OF_DAY: Record<TimeOfDay, [number, number]> = { any: [0, 24 * 60], morning: [7 * 60, 12 * 60], afternoon: [12 * 60, 18 * 60], evening: [18 * 60, 23 * 60] };

const ACTIVITY: Record<PlanType, RegExp> = {
  meeting: /\b(meetings?|calls?|appointments?)\b/i,
  coffee: /\bcoffees?\b/i,
  dinner: /\bdinners?\b/i,
  lunch: /\blunch(es)?\b/i,
  sport: /\b(sports?|gym|training|padel|tennis|football|running|workouts?)\b/i,
  walk: /\bwalks?\b/i,
  custom: /$^/,
};
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface RuleLimits { earliest?: number; latest?: number; noDays: Set<number> }

/**
 * Reads the user's simple time rules ("no meetings before 9", "no dinners on Sunday", "never after 21:00")
 * for this kind of plan. A rule that names no activity applies to every plan; one that names others doesn't.
 */
export function ruleLimits(rules: RuleLike[], type: PlanType): RuleLimits {
  const out: RuleLimits = { noDays: new Set() };
  for (const r of rules) {
    const t = r.text.toLowerCase();
    const negative = r.kind === 'dont' || /\b(no|never|not|don'?t|avoid)\b/.test(t);
    if (!negative) continue;
    const names = (Object.keys(ACTIVITY) as PlanType[]).filter((k) => ACTIVITY[k].test(t));
    if (names.length && !names.includes(type)) continue;
    const hour = (m: RegExpExecArray) => {
      let h = Number(m[1]) % 24;
      if (m[3] === 'pm' && h < 12) h += 12;
      return h * 60 + Number(m[2] ?? 0);
    };
    const before = /\bbefore\s+(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm)?/.exec(t);
    if (before) out.earliest = Math.max(out.earliest ?? 0, hour(before));
    const after = /\bafter\s+(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm)?/.exec(t);
    if (after) out.latest = Math.min(out.latest ?? 24 * 60, hour(after));
    if (/\bweekends?\b/.test(t) && /\b(on|at)\b/.test(t)) { out.noDays.add(0); out.noDays.add(6); }
    for (const [i, d] of DAYS.entries()) if (new RegExp(`\\b(on\\s+)?${d}s?\\b`).test(t)) out.noDays.add(i);
  }
  return out;
}

/** "9-17", "09:00–17:30", "8h to 16h" → minutes. */
export function parseWorkingHours(value: string | undefined): [number, number] | undefined {
  const m = value ? /(\d{1,2})(?:[:h.](\d{2}))?\s*(?:-|–|to|bis|à)\s*(\d{1,2})(?:[:h.](\d{2}))?/i.exec(value) : null;
  if (!m) return undefined;
  const a = Number(m[1]) * 60 + Number(m[2] ?? 0);
  const b = Number(m[3]) * 60 + Number(m[4] ?? 0);
  return a < b ? [a, b] : undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');
function* datesBetween(from: string, to: string) {
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  for (let i = 0; d <= end && i < MAX_DAYS; i++) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

/** Every free start (30-minute grid) for one person, in their own timezone, rules and working hours. */
export function freeStarts(o: { tz: string; q: SlotQuery; busy: Busy[]; rules?: RuleLike[]; workingHours?: [number, number]; now: Date }): Date[] {
  const [ts, te] = TYPE_WINDOW[o.q.type];
  const [ds, de] = TIME_OF_DAY[o.q.timeOfDay];
  const lim = ruleLimits(o.rules ?? [], o.q.type);
  let start = Math.max(ts, ds, lim.earliest ?? 0);
  let end = Math.min(te, de, lim.latest ?? 24 * 60);
  if (o.q.type === 'meeting') {
    const [ws, we] = o.workingHours ?? [9 * 60, 18 * 60];
    start = Math.max(start, ws);
    end = Math.min(end, we);
  }
  const out: Date[] = [];
  const earliest = o.now.getTime() + MIN_NOTICE_MS;
  for (const date of datesBetween(o.q.dateFrom, o.q.dateTo)) {
    if (lim.noDays.has(new Date(`${date}T12:00:00Z`).getUTCDay())) continue;
    for (let m = Math.ceil(start / STEP) * STEP; m + o.q.durationMin <= end; m += STEP) {
      const s = parseLocal(`${date}T${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`, o.tz);
      const e = new Date(s.getTime() + o.q.durationMin * 60_000);
      if (s.getTime() < earliest) continue;
      if (o.busy.some((b) => b.start < e && b.end > s)) continue;
      out.push(s);
    }
  }
  return out;
}

const localDay = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/**
 * Up to `max` candidates spread over different days: per day the first free time, on the hour when
 * possible. Deterministic, so two people free at the same times pick the same candidates (group plans).
 */
export function pickCandidates(starts: Date[], tz: string, max = 3): Date[] {
  const byDay = new Map<string, Date[]>();
  for (const s of [...starts].sort((a, b) => a.getTime() - b.getTime())) {
    const k = localDay(s, tz);
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  const firstOf = (list: Date[]) => list.find((s) => s.getUTCMinutes() === 0) ?? list[0]!;
  const picks: Date[] = [];
  for (const list of byDay.values()) {
    if (picks.length >= max) break;
    picks.push(firstOf(list));
  }
  // Fewer days than needed: a second time on the same days, at least 2 hours later.
  for (const list of byDay.values()) {
    if (picks.length >= max) break;
    const first = firstOf(list);
    const later = list.filter((s) => s.getTime() >= first.getTime() + 2 * 3_600_000);
    if (later.length) picks.push(firstOf(later));
  }
  return picks.sort((a, b) => a.getTime() - b.getTime());
}

/** Starts present in every list (exact instants). */
export function intersect(lists: Date[][]): Date[] {
  if (!lists.length) return [];
  const [first, ...rest] = lists;
  const sets = rest.map((l) => new Set(l.map((d) => d.getTime())));
  return first!.filter((d) => sets.every((s) => s.has(d.getTime())));
}

/** "Tue 4 Nov 10:00" in the viewer's timezone. */
export function fmtSlot(d: Date, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`;
}
