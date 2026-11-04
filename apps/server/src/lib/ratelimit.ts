import { config } from '../config.ts';

// Phase 3c: fixed-window counters per key (IP, user, email). HACKATHON: in memory, per process.

const windows = new Map<string, { until: number; n: number }>();

/** Counts a hit; true when the limit is exceeded (the caller answers 429). */
export function limited(key: string, max: number, windowMs: number): boolean {
  if (!config.RATE_LIMITS) return false;
  const now = Date.now();
  if (windows.size > 50_000) for (const [k, w] of windows) if (w.until < now) windows.delete(k);
  const w = windows.get(key);
  if (!w || w.until < now) {
    windows.set(key, { until: now + windowMs, n: 1 });
    return false;
  }
  w.n++;
  return w.n > max;
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
