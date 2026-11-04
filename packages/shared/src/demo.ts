// Demo accounts (users.account_kind 'demo') for the video and the judges: neutral, made-up services in place
// of real brands. Real users never see any of this; demo accounts never see the real brands' services.
// Used by the server (Store, agent prompt, hand-off tools) and the web (Store icons, sources, /demo/* pages).

export const DEMO_ACCOUNT_KIND = 'demo';
export const isDemoAccount = (kind?: string | null) => kind === DEMO_ACCOUNT_KIND;

/** The neutral services. `provider` is the hand-off tools' provider id they stand in for. */
export const DEMO_SERVICES = [
  { slug: 'demo-stayfinder', id: 'stayfinder', name: 'StayFinder', category: 'travel', page: 'stay', provider: 'booking', replaces: 'Booking.com',
    tagline: 'Your stays, upcoming trips and how you like to travel', icon: '/demo-icons/stayfinder.svg' },
  { slug: 'demo-flynow', id: 'flynow', name: 'FlyNow', category: 'travel', page: 'fly', provider: 'skyscanner', replaces: 'Skyscanner',
    tagline: 'Your flights, routes you fly often and good fares', icon: '/demo-icons/flynow.svg' },
  { slug: 'demo-shopmate', id: 'shopmate', name: 'ShopMate', category: 'shopping', page: 'shop', provider: 'amazon', replaces: 'Amazon.de',
    tagline: 'Your orders, what you reorder and when it arrives', icon: '/demo-icons/shopmate.svg' },
] as const;
export type DemoService = (typeof DEMO_SERVICES)[number];
export const DEMO_CONNECTOR_PREFIX = 'demo-';
export const isDemoConnector = (slug: string) => slug.startsWith(DEMO_CONNECTOR_PREFIX);
/**
 * Which Service Store entries an account sees: real users never see the demo services; demo accounts see
 * only the demo services and partner organisations (type 'org', e.g. Yousoft IT), no real brands.
 */
export const connectorVisibleTo = (c: { slug: string; type: string }, accountKind?: string | null) =>
  isDemoAccount(accountKind) ? isDemoConnector(c.slug) || c.type === 'org' : !isDemoConnector(c.slug);
export const demoServiceFor =(provider: string) => DEMO_SERVICES.find((s) => s.provider === provider || s.id === provider);

/** "Where I look first" for demo accounts: only the neutral names. */
export const DEMO_PROVIDER_CATEGORIES = [
  { id: 'shopping', label: 'Shopping', providers: [['shopmate', 'ShopMate', 'i-persons.com/demo/shop']] },
  { id: 'travel', label: 'Travel', providers: [['stayfinder', 'StayFinder', 'i-persons.com/demo/stay'], ['flynow', 'FlyNow', 'i-persons.com/demo/fly']] },
] as const;
export const isDemoProvider = (id: string) => DEMO_PROVIDER_CATEGORIES.some((c) => (c.providers as readonly (readonly string[])[]).some((p) => p[0] === id));

/** Real brand names in the agent's own instructions, swapped for the neutral ones on demo accounts. */
const BRAND_SWAPS: [RegExp, string][] = [
  [/Booking\.com/g, 'StayFinder'], [/booking\.com/g, 'StayFinder'], [/Skyscanner/g, 'FlyNow'],
  [/Amazon\.de/g, 'ShopMate'], [/\bAmazon\b/g, 'ShopMate'], [/The Weather Channel/g, 'a weather site'],
];
export const neutralBrands = (text: string) => BRAND_SWAPS.reduce((t, [re, to]) => t.replace(re, to), text);

// --- sample listings on the demo pages (and what find_offers returns for demo accounts) ---

export interface DemoStay { title: string; area: string; stars: number; pricePerNight: number; freeCancellation: boolean; rating: number }
export interface DemoProduct { ref: string; title: string; price: number; note: string }
export interface DemoFlight { title: string; price: number; stops: number; depart: string; arrive: string }

/** Three made-up hotels for any city (no real hotel names). Prices in EUR per night. */
export function demoStays(city: string, opts: { stars?: number; freeCancellation?: boolean } = {}): DemoStay[] {
  const all: DemoStay[] = [
    { title: `4★ hotel by ${city} Central Station`, area: 'Central Station', stars: 4, pricePerNight: 118, freeCancellation: true, rating: 8.7 },
    { title: `4★ design hotel in the old town`, area: 'Old town', stars: 4, pricePerNight: 129, freeCancellation: true, rating: 9.0 },
    { title: `4★ business hotel near the trade fair`, area: 'Trade fair', stars: 4, pricePerNight: 104, freeCancellation: true, rating: 8.4 },
    { title: `3★ city hotel, breakfast included`, area: 'City centre', stars: 3, pricePerNight: 89, freeCancellation: false, rating: 8.1 },
  ];
  return all.filter((s) => (!opts.stars || s.stars === Math.round(opts.stars)) && (!opts.freeCancellation || s.freeCancellation)).slice(0, 3);
}

export const DEMO_PRODUCTS: DemoProduct[] = [
  { ref: 'SMCOFFEE50', title: 'Espresso capsules, intense, 50 pack', price: 18.99, note: 'Your usual' },
  { ref: 'SMCOFFEE30', title: 'Lungo capsules, mild, 30 pack', price: 12.49, note: 'Similar' },
  { ref: 'SMCHOCO001', title: 'Dark chocolate pralines, gift box', price: 14.90, note: 'Popular gift' },
  { ref: 'SMALBUM001', title: 'Linen photo album, 60 pages', price: 24.90, note: 'Popular gift' },
];
export const demoProducts = (query: string, ref?: string): DemoProduct[] => {
  const q = query.toLowerCase();
  const hit = DEMO_PRODUCTS.filter((p) => p.ref === ref || q.split(/\W+/).some((w) => w.length > 3 && p.title.toLowerCase().includes(w.replace(/s$/, ''))));
  return hit.length ? hit : DEMO_PRODUCTS.slice(0, 2);
};

export function demoFlights(from: string, to: string): DemoFlight[] {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  return [
    { title: `${f} → ${t}, direct, morning`, price: 189, stops: 0, depart: '07:40', arrive: '10:15' },
    { title: `${f} → ${t}, direct, evening`, price: 164, stops: 0, depart: '18:20', arrive: '20:55' },
    { title: `${f} → ${t}, 1 stop`, price: 132, stops: 1, depart: '09:05', arrive: '14:30' },
  ];
}

/**
 * DEMO: the jury scenes' sentences per demo account, shown on Talk as one-tap chips (a fallback when the mic
 * can't be used while recording). Keyed by email; the first one is the scene's main line.
 */
export const DEMO_PROMPTS: Record<string, string[]> = {
  'sara@i-persons.com': ['Plan a coffee with my mom next week', 'After my classes, around 6 pm, somewhere in Berlin', "What's on my calendar next week?"],
  'hana@i-persons.com': ["What's on my calendar next week?", 'Who is Sara?', 'Remember that I love dark chocolate'],
  'adam@i-persons.com': ['Book Thursday at ten with the supplier', 'Book Friday at eight with the supplier', 'Find me a hotel in Munich like last time', 'Email the supplier the new drawings'],
  'giga@i-persons.com': ['شنوة عندي الجمعة الجاية؟', 'احكيلي على عرسي في صفاقس', 'Call my son Adam on Sunday at 6 pm'],
  'demo@i-persons.test': ['Am I free tomorrow afternoon?', 'Book a coffee with Sam on Friday at 10', 'Find me a hotel in Munich like last time'],
  'judge-demo@i-persons.com': ['Find me a hotel in Munich like last time', 'Am I free tomorrow afternoon?', 'Book a coffee with Sam on Friday at 10'],
};
export const demoPromptsFor = (email?: string | null): string[] | undefined => (email ? DEMO_PROMPTS[email.toLowerCase()] : undefined);
