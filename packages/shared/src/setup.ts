import { DEMO_PROVIDER_CATEGORIES } from './demo.ts';
// First-run setup ("warm-up"): the choices the web offers as taps, and the server validates against.

export const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' },
  { id: 'ar', label: 'العربية' },
  { id: 'de', label: 'Deutsch' },
] as const;

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'TND', 'DKK', 'CHF', 'CAD', 'MAD', 'AED'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Countries offered in the picker (ISO 3166-1 alpha-2) with their usual currency; others can be typed. */
export const COUNTRIES: { id: string; label: string; currency: Currency }[] = [
  { id: 'DE', label: 'Germany', currency: 'EUR' },
  { id: 'TN', label: 'Tunisia', currency: 'TND' },
  { id: 'DK', label: 'Denmark', currency: 'DKK' },
  { id: 'US', label: 'United States', currency: 'USD' },
  { id: 'FR', label: 'France', currency: 'EUR' },
  { id: 'GB', label: 'United Kingdom', currency: 'GBP' },
  { id: 'CH', label: 'Switzerland', currency: 'CHF' },
  { id: 'CA', label: 'Canada', currency: 'CAD' },
  { id: 'MA', label: 'Morocco', currency: 'MAD' },
  { id: 'AE', label: 'United Arab Emirates', currency: 'AED' },
];

export const currencyFor = (country: string | null | undefined): Currency =>
  COUNTRIES.find((c) => c.id === country)?.currency ?? 'USD';

const SHORT_NAMES: Record<string, string> = {
  mohamed: 'Med', mohammed: 'Med', muhammad: 'Med', mohammad: 'Med', ahmed: 'Ahmed',
  alexander: 'Alex', alexandra: 'Alex', elizabeth: 'Liz', katherine: 'Kate', christopher: 'Chris', michael: 'Mike',
};

/** Twin names for "Mohamed Amri": i-Mohamed, i-Med, i-MA. */
export function suggestTwinNames(fullName: string): string[] {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (!first) return ['i-Me', 'i-Twin'];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const short = SHORT_NAMES[first.toLowerCase()] ?? (first.length > 5 ? cap(first.slice(0, 3)) : null);
  const initials = parts.length > 1 ? parts.map((p) => p[0]!.toUpperCase()).join('').slice(0, 3) : null;
  return [...new Set([`i-${cap(first)}`, short && `i-${short}`, initials && `i-${initials}`].filter((x): x is string => Boolean(x)))];
}

/** "Centre of interest": answered by tapping; each answer is saved as a preference fact. */
export const INTEREST_QUESTIONS = [
  { key: 'free_time', q: 'What do you enjoy in your free time?', multi: true,
    options: ['Sport', 'Reading', 'Travel', 'Cooking', 'Music', 'Gaming', 'Movies & series', 'Nature', 'Family time', 'Learning'] },
  { key: 'sport', q: 'Any sport you do or follow?', multi: true,
    options: ['Football', 'Running', 'Gym', 'Yoga', 'Table tennis', 'Swimming', 'Cycling', 'Tennis', 'None'] },
  { key: 'travel_style', q: 'Your kind of trip?', multi: true,
    options: ['Beach', 'City breaks', 'Mountains', 'Road trips', 'Budget', 'Comfort / 4★+', 'Short flights only', 'I rarely travel'] },
  { key: 'work', q: 'What describes your work?', multi: false,
    options: ['Employee', 'Freelancer', 'Founder', 'Student', 'Looking for a job', 'Retired', 'Other'] },
  { key: 'learn', q: 'What would you like to learn or improve?', multi: true,
    options: ['A language', 'Coding / AI', 'Business', 'Health & fitness', 'Finance & investing', 'Photography', 'Nothing right now'] },
  { key: 'help_with', q: 'Where should your i-person help most?', multi: true,
    options: ['Saving money', 'Finding deals', 'Planning trips', 'Job offers', 'My calendar', 'Staying informed', 'Healthy habits'] },
] as const;

export const RULE_SOURCES = ['user', 'onboarding', 'chat', 'learned', 'system'] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];
export const RULE_SOURCE_LABELS: Record<RuleSource, string> = {
  user: 'Set by you', onboarding: 'Set at setup', chat: 'From a chat', learned: 'Learned from your behaviour', system: 'i-persons default',
};

/** Starting points for "what should / shouldn't my i-person do": tap to add, edit later on My twin. */
export const RULE_SUGGESTIONS = {
  do: [
    'Answer briefly and to the point',
    'Always show prices in my currency',
    'Prefer free cancellation when booking',
    'Remind me of birthdays and appointments',
    'Suggest cheaper alternatives',
    'Speak to me informally',
  ],
  dont: [
    'Never book anything on Sundays',
    'Never contact my employer',
    'Never suggest alcohol or gambling',
    'Never share my phone number',
    'Don’t suggest flights with more than one stop',
    'Don’t send me suggestions late at night',
  ],
} as const;

/** Sources of insights and recommendations, by category; the user picks and orders them. */
export const PROVIDER_CATEGORIES = [
  { id: 'shopping', label: 'Shopping', providers: [
    ['amazon', 'Amazon', 'amazon.com'], ['walmart', 'Walmart', 'walmart.com'], ['ebay', 'eBay', 'ebay.com'],
    ['aliexpress', 'AliExpress', 'aliexpress.com'], ['zalando', 'Zalando', 'zalando.com'], ['ikea', 'IKEA', 'ikea.com'] ] },
  { id: 'travel', label: 'Travel', providers: [
    ['booking', 'Booking.com', 'booking.com'], ['skyscanner', 'Skyscanner', 'skyscanner.net'], ['airbnb', 'Airbnb', 'airbnb.com'],
    ['expedia', 'Expedia', 'expedia.com'], ['tripadvisor', 'Tripadvisor', 'tripadvisor.com'], ['kayak', 'KAYAK', 'kayak.com'] ] },
  { id: 'jobs', label: 'Jobs', providers: [
    ['linkedin-jobs', 'LinkedIn Jobs', 'linkedin.com/jobs'], ['indeed', 'Indeed', 'indeed.com'], ['glassdoor', 'Glassdoor', 'glassdoor.com'],
    ['stepstone', 'StepStone', 'stepstone.de'], ['upwork', 'Upwork', 'upwork.com'], ['yousoft', 'Yousoft-IT', 'yousoft-it.com'] ] },
  { id: 'education', label: 'Education', providers: [
    ['coursera', 'Coursera', 'coursera.org'], ['udemy', 'Udemy', 'udemy.com'], ['edx', 'edX', 'edx.org'],
    ['khan', 'Khan Academy', 'khanacademy.org'], ['duolingo', 'Duolingo', 'duolingo.com'], ['linkedin-learning', 'LinkedIn Learning', 'linkedin.com/learning'] ] },
  { id: 'sport', label: 'Sport', providers: [
    ['strava', 'Strava', 'strava.com'], ['decathlon', 'Decathlon', 'decathlon.com'], ['espn', 'ESPN', 'espn.com'],
    ['eurosport', 'Eurosport', 'eurosport.com'], ['nike', 'Nike', 'nike.com'] ] },
  { id: 'news', label: 'News', providers: [
    ['bbc', 'BBC News', 'bbc.com/news'], ['reuters', 'Reuters', 'reuters.com'], ['aljazeera', 'Al Jazeera', 'aljazeera.com'],
    ['guardian', 'The Guardian', 'theguardian.com'], ['lemonde', 'Le Monde', 'lemonde.fr'], ['spiegel', 'Der Spiegel', 'spiegel.de'] ] },
  { id: 'technology', label: 'Technology', providers: [
    ['techcrunch', 'TechCrunch', 'techcrunch.com'], ['verge', 'The Verge', 'theverge.com'], ['hackernews', 'Hacker News', 'news.ycombinator.com'],
    ['github', 'GitHub', 'github.com'], ['producthunt', 'Product Hunt', 'producthunt.com'], ['wired', 'WIRED', 'wired.com'] ] },
] as const;

export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number]['id'];
export const providerById = (id: string) => {
  for (const c of PROVIDER_CATEGORIES) for (const [pid, name, site] of c.providers) if (pid === id) return { id: pid, name, site, category: c.id };
  // Demo accounts' neutral sources (demo.ts); the sources API accepts them only from demo accounts.
  for (const c of DEMO_PROVIDER_CATEGORIES) for (const [pid, name, site] of c.providers) if (pid === id) return { id: pid, name, site, category: c.id };
  return undefined;
};

// Only sites the user owns are fetched (one page, robots.txt respected); LinkedIn is pasted or uploaded as a PDF instead.
export const LINK_KINDS = ['website', 'portfolio', 'other'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** Setup steps in order; verify, about_you, twin_name and avatar are required, the rest offer "Later". */
export const SETUP_STEPS = ['verify', 'gift', 'about_you', 'twin_name', 'avatar', 'know_more', 'interests', 'rules', 'sources', 'warmup'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
