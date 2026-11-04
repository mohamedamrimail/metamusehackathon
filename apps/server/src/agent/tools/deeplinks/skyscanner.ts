// Skyscanner prefilled flight search (hand-off). Path: /transport/flights/<from>/<to>/<yymmdd>[/<yymmdd>]/.
// Checked Oct 31: skyscanner.net routes this path (its bot check keeps it as the return URL); please
// also confirm in a browser before the demo.

export interface FlightSearch { from: string; to: string; depart: string; returnDate?: string; adults?: number; cabin?: 'economy' | 'premiumeconomy' | 'business' | 'first' }

const yymmdd = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('dates must be YYYY-MM-DD');
  return d.slice(2).replace(/-/g, '');
};

export function skyscannerUrl(s: FlightSearch): string {
  const iata = (c: string) => {
    if (!/^[A-Za-z]{3}$/.test(c)) throw new Error('airports must be 3-letter IATA codes');
    return c.toLowerCase();
  };
  const dates = [yymmdd(s.depart), ...(s.returnDate ? [yymmdd(s.returnDate)] : [])].join('/');
  const q = new URLSearchParams({ adultsv2: String(s.adults ?? 1), cabinclass: s.cabin ?? 'economy' });
  return `https://www.skyscanner.net/transport/flights/${iata(s.from)}/${iata(s.to)}/${dates}/?${q}`;
}
