import { AsyncLocalStorage } from 'node:async_hooks';
import { desc, gte } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { voiceLatency } from '../db/schema.ts';

// Voice latency (jury prompt §8): each voice turn on Talk carries a clock through the pipeline
// (channels/web.ts marks speech end, transcript, reply and the hand-off to the browser voice; the runtime marks the first model
// response through AsyncLocalStorage), then one row lands in voice_latency. Admins see p50/p90.

export type Stage = 'speechEnd' | 'transcript' | 'firstModel' | 'reply' | 'firstAudio';
export type TtsMode = 'server' | 'fallback' | 'browser' | 'none';

/** Timestamps (ms) of one voice turn; each stage keeps its first mark. */
export class VoiceTurnClock {
  readonly at: Partial<Record<Stage, number>> = {};
  /** How the reply was voiced when no server audio was sent. */
  ttsMode?: Exclude<TtsMode, 'server'>;
  /** Set once the reply's speech took this clock (so the turn doesn't record it as unspoken). */
  claimed = false;
  private recorded = false;

  constructor(private now: () => number = () => performance.timeOrigin + performance.now()) {}

  mark(stage: Stage): void {
    this.at[stage] ??= this.now();
  }

  /** True the first time only: a turn is recorded once. */
  takeRecord(): boolean {
    if (this.recorded) return false;
    this.recorded = true;
    return true;
  }
}

export interface LatencyRow {
  sttMs: number | null;
  firstModelMs: number | null;
  replyMs: number | null;
  ttsMs: number | null;
  totalMs: number | null;
  ttsMode: TtsMode;
}

const span = (a?: number, b?: number) => (a === undefined || b === undefined ? null : Math.max(0, Math.round(b - a)));

export function latencyRow(c: VoiceTurnClock): LatencyRow {
  const t = c.at;
  return {
    sttMs: span(t.speechEnd, t.transcript),
    firstModelMs: span(t.transcript, t.firstModel),
    replyMs: span(t.transcript, t.reply),
    ttsMs: span(t.reply, t.firstAudio),
    totalMs: span(t.speechEnd, t.firstAudio),
    ttsMode: c.ttsMode ?? (t.firstAudio !== undefined ? 'server' : 'none'),
  };
}

const current = new AsyncLocalStorage<VoiceTurnClock>();

/** Runs a voice turn with its clock in scope, so the runtime can mark the first model response. */
export const withVoiceClock = <T>(clock: VoiceTurnClock, fn: () => Promise<T>): Promise<T> => current.run(clock, fn);

/** Hook for agent/runtime.ts after each model call; only the first one of a voice turn counts. */
export const markModelResponse = (): void => current.getStore()?.mark('firstModel');

/** Stores the turn (once). Turns that never reached a transcript (no speech) are skipped. */
export async function recordVoiceLatency(db: Db, ipersonId: string, clock: VoiceTurnClock): Promise<LatencyRow | null> {
  if (clock.at.transcript === undefined || !clock.takeRecord()) return null;
  const row = latencyRow(clock);
  await db.insert(voiceLatency).values({ ipersonId, ...row });
  return row;
}

/** Linear interpolation between closest ranks (same as Postgres percentile_cont). */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = (s.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return Math.round(s[lo]! + (s[hi]! - s[lo]!) * (rank - lo));
}

export const STAGES = [
  { key: 'sttMs', label: 'End of speech → final transcript' },
  { key: 'firstModelMs', label: 'Final transcript → first model response (not streamed)' },
  { key: 'replyMs', label: 'Final transcript → final reply text (tools + rules check)' },
  { key: 'ttsMs', label: 'Final reply → sent to the browser voice' },
  { key: 'totalMs', label: 'End of speech → reply sent to the browser voice (total)' },
] as const satisfies readonly { key: keyof Omit<LatencyRow, 'ttsMode'>; label: string }[];

export interface LatencySummary {
  days: number;
  turns: number;
  tts_modes: Record<string, number>;
  stages: { key: string; label: string; n: number; p50: number | null; p90: number | null }[];
}

export function summarizeLatency(rows: LatencyRow[], days: number): LatencySummary {
  const modes: Record<string, number> = {};
  for (const r of rows) modes[r.ttsMode] = (modes[r.ttsMode] ?? 0) + 1;
  return {
    days,
    turns: rows.length,
    tts_modes: modes,
    stages: STAGES.map(({ key, label }) => {
      const v = rows.map((r) => r[key]).filter((x): x is number => x !== null);
      return { key, label, n: v.length, p50: percentile(v, 0.5), p90: percentile(v, 0.9) };
    }),
  };
}

/** p50/p90 per stage over the last `days` (at most the newest 5000 turns). */
export async function latencySummary(db: Db, days = 7): Promise<LatencySummary> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.select().from(voiceLatency).where(gte(voiceLatency.createdAt, since)).orderBy(desc(voiceLatency.createdAt)).limit(5000);
  return summarizeLatency(rows.map((r) => ({ ...r, ttsMode: r.ttsMode as TtsMode })), days);
}
