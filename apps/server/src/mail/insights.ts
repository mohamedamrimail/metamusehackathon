// M4: insights computed in code from purchases and bookings (numbers never come from the model).
// Pure functions over rows; the caller stores them and turns confident ones into profile facts.

export interface PurchaseRow { id: string; merchant: string; title: string; itemRef: string | null; category: string | null; quantity: number; amountCents: number | null; currency: string | null; orderedAt: Date; deliveryAt: Date | null }
export interface BookingRow { id: string; kind: string; title: string; city: string | null; routeFrom: string | null; routeTo: string | null; stars: number | null; nights: number | null; startAt: Date | null; endAt: Date | null; bookedAt: Date | null; freeCancellation: boolean | null; source: string }

export interface Insight {
  kind: 'travel_pattern' | 'travel_route' | 'upcoming' | 'reorder' | 'spending' | 'booking_habit';
  key: string;
  group: 'travel' | 'shopping' | 'upcoming';
  title: string;
  body: string;
  data: Record<string, unknown>;
  evidence: string[];
  confidence: number;
  validUntil?: Date;
}

const DAY = 86_400_000;
export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const confidence = (n: number) => (n >= 4 ? 0.9 : n === 3 ? 0.8 : 0.6);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const money = (cents: number, cur: string) => `${cur === 'EUR' ? '€' : cur === 'USD' ? '$' : `${cur} `}${Math.round(cents / 100)}`;
/** Same product across orders: ASIN/SKU if known, else the normalised title. */
const itemKey = (p: PurchaseRow) => (p.itemRef ?? p.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 6).join(' '));

export function computeInsights(purchases: PurchaseRow[], bookings: BookingRow[], now: Date): Insight[] {
  const out: Insight[] = [];
  const hotels = bookings.filter((b) => b.kind === 'hotel');
  const flights = bookings.filter((b) => b.kind === 'flight');

  // travel_pattern: repeat stays in a city.
  const byCity = new Map<string, BookingRow[]>();
  for (const h of hotels) if (h.city) byCity.set(h.city.toLowerCase(), [...(byCity.get(h.city.toLowerCase()) ?? []), h]);
  for (const [city, stays] of byCity) {
    if (stays.length < 2) continue;
    const name = stays[0]!.city!;
    const nights = median(stays.map((s) => s.nights ?? NaN).filter(Number.isFinite));
    const stars = median(stays.map((s) => s.stars ?? NaN).filter(Number.isFinite));
    const freeCancel = stays.filter((s) => s.freeCancellation).length / stays.length;
    const parts = [Number.isFinite(nights) && `usually ${plural(Math.round(nights), 'night')}`, Number.isFinite(stars) && `${Math.round(stars)}-star`, freeCancel >= 0.6 && 'free cancellation'].filter(Boolean);
    out.push({
      kind: 'travel_pattern', key: `travel_pattern:${city}`, group: 'travel',
      title: `You stayed in ${name} ${stays.length} times`, body: parts.length ? `${parts.join(', ')}.` : 'A city you come back to.',
      data: { city: name, stays: stays.length, nights, stars, freeCancellationShare: freeCancel },
      evidence: stays.map((s) => s.id), confidence: confidence(stays.length),
    });
  }

  // travel_route: the same flight route repeatedly, with its typical interval.
  const byRoute = new Map<string, BookingRow[]>();
  for (const f of flights) if (f.routeFrom && f.routeTo && f.startAt) {
    const k = `${f.routeFrom.toUpperCase()}-${f.routeTo.toUpperCase()}`;
    byRoute.set(k, [...(byRoute.get(k) ?? []), f]);
  }
  for (const [route, legs] of byRoute) {
    if (legs.length < 2) continue;
    const dates = legs.map((l) => l.startAt!.getTime()).sort((a, b) => a - b);
    const gaps = dates.slice(1).map((d, i) => (d - dates[i]!) / DAY);
    const weeks = Math.max(1, Math.round(median(gaps) / 7));
    out.push({
      kind: 'travel_route', key: `travel_route:${route}`, group: 'travel',
      title: `You fly ${route.replace('-', ' → ')} about every ${plural(weeks, 'week')}`, body: `${plural(legs.length, 'flight')} on this route in your emails.`,
      data: { route, flights: legs.length, intervalDays: Math.round(median(gaps)) },
      evidence: legs.map((l) => l.id), confidence: confidence(legs.length),
    });
  }

  // booking_habit: how far ahead hotels are booked.
  const leads = hotels.filter((h) => h.bookedAt && h.startAt).map((h) => (h.startAt!.getTime() - h.bookedAt!.getTime()) / DAY).filter((d) => d >= 0);
  if (leads.length >= 2) {
    const days = Math.round(median(leads));
    out.push({
      kind: 'booking_habit', key: 'booking_habit:hotel_lead', group: 'travel',
      title: days >= 10 ? `You book hotels about ${plural(Math.round(days / 7), 'week')} ahead` : `You book hotels about ${plural(days, 'day')} ahead`,
      body: `Based on ${plural(leads.length, 'booking')}.`, data: { medianLeadDays: days }, evidence: hotels.filter((h) => h.bookedAt && h.startAt).map((h) => h.id), confidence: confidence(leads.length),
    });
  }

  // upcoming: future stays/flights (60 days) and deliveries (7 days).
  for (const b of bookings) {
    if (!b.startAt || b.startAt < now || b.startAt.getTime() - now.getTime() > 60 * DAY) continue;
    const inDays = Math.ceil((b.startAt.getTime() - now.getTime()) / DAY);
    out.push({
      kind: 'upcoming', key: `upcoming:${b.id}`, group: 'upcoming',
      title: b.kind === 'flight' ? `Flight ${b.routeFrom ?? ''} → ${b.routeTo ?? ''} in ${plural(inDays, 'day')}` : `${b.city ?? b.title} in ${plural(inDays, 'day')}`,
      body: b.kind === 'flight' ? `${fmtDate(b.startAt)} — ${b.title}` : `Check-in ${fmtDate(b.startAt)}${b.nights ? `, ${plural(b.nights, 'night')}` : ''} — ${b.title}`,
      data: { bookingId: b.id, startAt: b.startAt.toISOString() }, evidence: [b.id], confidence: 1, validUntil: b.endAt ?? b.startAt,
    });
  }
  for (const p of purchases) {
    if (!p.deliveryAt || p.deliveryAt < new Date(now.getTime() - DAY / 2) || p.deliveryAt.getTime() - now.getTime() > 7 * DAY) continue;
    const inDays = Math.max(0, Math.ceil((p.deliveryAt.getTime() - now.getTime()) / DAY));
    out.push({
      kind: 'upcoming', key: `upcoming:${p.id}`, group: 'upcoming',
      title: `Parcel from ${p.merchant} arriving ${inDays === 0 ? 'today' : inDays === 1 ? 'tomorrow' : `in ${inDays} days`}`, body: p.title,
      data: { purchaseId: p.id, deliveryAt: p.deliveryAt.toISOString() }, evidence: [p.id], confidence: 1, validUntil: p.deliveryAt,
    });
  }

  // reorder: the same item bought 2+ times; next ≈ last + median interval.
  const byItem = new Map<string, PurchaseRow[]>();
  for (const p of purchases) byItem.set(`${p.merchant}|${itemKey(p)}`, [...(byItem.get(`${p.merchant}|${itemKey(p)}`) ?? []), p]);
  for (const [k, orders] of byItem) {
    const dates = [...new Set(orders.map((o) => o.orderedAt.getTime()))].sort((a, b) => a - b);
    if (dates.length < 2) continue;
    const gaps = dates.slice(1).map((d, i) => (d - dates[i]!) / DAY);
    const interval = median(gaps);
    if (interval < 3) continue; // same week: not a habit
    const next = new Date(dates.at(-1)! + interval * DAY);
    const p = orders[0]!;
    out.push({
      kind: 'reorder', key: `reorder:${k}`, group: 'shopping',
      title: `${p.title} about every ${interval >= 14 ? plural(Math.round(interval / 7), 'week') : plural(Math.round(interval), 'day')}`,
      body: `Next around ${fmtDate(next)}.`, data: { merchant: p.merchant, item: p.title, itemRef: p.itemRef, intervalDays: Math.round(interval), nextAt: next.toISOString() },
      evidence: orders.map((o) => o.id), confidence: confidence(dates.length), validUntil: new Date(next.getTime() + 14 * DAY),
    });
  }

  // spending: per merchant per month across the window, with top categories.
  const byMerchant = new Map<string, PurchaseRow[]>();
  for (const p of purchases) if (p.amountCents != null) byMerchant.set(p.merchant, [...(byMerchant.get(p.merchant) ?? []), p]);
  for (const [merchant, rows] of byMerchant) {
    if (rows.length < 2) continue;
    const cur = rows[0]!.currency ?? 'EUR';
    const same = rows.filter((r) => (r.currency ?? cur) === cur);
    const total = same.reduce((n, r) => n + (r.amountCents ?? 0), 0);
    const first = Math.min(...same.map((r) => r.orderedAt.getTime()));
    const months = Math.max(1, (now.getTime() - first) / (30 * DAY));
    const cats = new Map<string, number>();
    for (const r of same) if (r.category) cats.set(r.category, (cats.get(r.category) ?? 0) + (r.amountCents ?? 0));
    const top = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
    out.push({
      kind: 'spending', key: `spending:${merchant.toLowerCase()}`, group: 'shopping',
      title: `${merchant}: about ${money(total / months, cur)} per month`, body: top.length ? `Mostly ${top.join(' and ')}.` : `${plural(same.length, 'order line')} in your emails.`,
      data: { merchant, perMonthCents: Math.round(total / months), currency: cur, topCategories: top, months: Math.round(months * 10) / 10 },
      evidence: same.map((r) => r.id), confidence: confidence(same.length),
    });
  }
  return out;
}
