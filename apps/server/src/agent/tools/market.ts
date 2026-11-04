// HACKATHON: simulated market for paper trading. Prices drift deterministically per symbol and hour,
// so a demo shows movement without any market data feed.

const BASE: Record<string, number> = { AAPL: 228, MSFT: 415, META: 590, NVDA: 140, TSLA: 250, AMZN: 190, GOOGL: 170, BTC: 68_000 };

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 2 ** 32;
}

export function lastPrice(symbol: string, now: Date): number | undefined {
  const base = BASE[symbol.toUpperCase()];
  if (base === undefined) return undefined;
  const hour = Math.floor(now.getTime() / 3_600_000);
  const drift = (hash(`${symbol}:${hour}`) - 0.5) * 0.04; // ±2 %
  return Math.round(base * (1 + drift) * 100) / 100;
}

export const SYMBOLS = Object.keys(BASE);
