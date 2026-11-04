// Booking.com prefilled hotel search (hand-off: the user finishes on Booking.com).
// Checked Oct 31: booking.com accepts this URL as-is (HTTP 202 to a script, no redirect); please also
// confirm in a browser before the demo. Filters: class=<stars>, fc=2 = free cancellation.

export interface BookingSearch { city: string; checkin: string; checkout: string; adults?: number; rooms?: number; children?: number; stars?: number; freeCancellation?: boolean }

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function bookingSearchUrl(s: BookingSearch): string {
  if (!DATE.test(s.checkin) || !DATE.test(s.checkout) || s.checkout <= s.checkin) throw new Error('checkin/checkout must be YYYY-MM-DD, checkout after checkin');
  const filters = [s.stars ? `class=${Math.round(s.stars)}` : null, s.freeCancellation ? 'fc=2' : null].filter(Boolean).join(';');
  const q = new URLSearchParams({
    ss: s.city, checkin: s.checkin, checkout: s.checkout,
    group_adults: String(s.adults ?? 2), no_rooms: String(s.rooms ?? 1), group_children: String(s.children ?? 0),
    ...(filters ? { nflt: filters } : {}),
  });
  return `https://www.booking.com/searchresults.html?${q}`;
}
