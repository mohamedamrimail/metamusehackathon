// Timezone helpers. The model reads and writes wall-clock times in the user's timezone.

function offsetMinutes(date: Date, tz: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

function fmtOffset(min: number): string {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** ISO-8601 with the timezone's offset, e.g. 2026-10-29T18:00:00+01:00. */
export function toLocalIso(date: Date, tz: string): string {
  const off = offsetMinutes(date, tz);
  const local = new Date(date.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${fmtOffset(off)}`;
}

/** Parses an ISO date-time; one without an offset is read as wall-clock time in `tz`. */
export function parseLocal(value: string, tz: string): Date {
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return new Date(value);
  const asUtc = new Date(`${value}Z`);
  if (Number.isNaN(asUtc.getTime())) return asUtc;
  // Two passes handle a DST change between the guess and the real instant.
  let guess = new Date(asUtc.getTime() - offsetMinutes(asUtc, tz) * 60_000);
  guess = new Date(asUtc.getTime() - offsetMinutes(guess, tz) * 60_000);
  return guess;
}

export function weekday(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(date);
}
