import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, like, ne, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CONSENT_VERSION, DEMO_SERVICES } from '@ipersons/shared';
import { charge, usdToMicros } from '../src/billing/credits.ts';
import { isFictionalNumber } from '../src/channels/whatsapp-client.ts';
import { config } from '../src/config.ts';
import type { Db } from '../src/db/client.ts';
import {
  actions, avatarAssets, bookings, calendarEvents, connectors, contacts, conversations, insights, ipersonRules, ipersons, partnerMatches,
  partnerMembers, partnerOffers, partnerRequests, partners, planSessions, profileFacts, purchases, sourcePrefs, twinConnections, users,
  userServices, visitorConversations,
} from '../src/db/schema.ts';
import { upsertFact } from '../src/agent/memory.ts';
import { parseLocal } from '../src/lib/time.ts';
import { PARTNER_SCOPES } from '../src/partners/core.ts';
import { refreshIdentifiers } from '../src/twins/identifiers.ts';
import { matchContacts } from '../src/twins/matching.ts';
import type { AppDeps } from '../src/http/deps.ts';
import { refreshInsights } from '../src/mail/sync.ts';

// The video demo, one family: Adam and his wife Hana (Berlin), their daughter Sara (Berlin) and Adam's mother Giga
// (Sfax). Demo accounts (account_kind 'demo') with made-up data only, the neutral
// demo services (StayFinder, FlyNow, ShopMate), a demo café partner (Café Lumière: venues, console, offers),
// public twins @adam @hana @sara @giga, Hana and Sara as connected twins, and avatars made by the app
// itself from AI-generated faces of people who don't exist. Used by seed-video-demo.ts and seed-local.ts.
// The four twins have their own i-persons.com mailboxes (jury demo logins, scripts/demo-passwords.ts); every other
// address is on a reserved domain (example.com / example.org); phone numbers are fictional
// (+1 202 555-01xx, never messaged: see isFictionalNumber).

export const PERSONAS = {
  adam: { email: 'adam@i-persons.com', name: 'Adam', handle: 'adam', display: 'i-Adam', phone: '+12025550101', locale: 'en', tz: 'Europe/Berlin', country: 'DE', currency: 'EUR', gender: 'man', age: '45-54' },
  hana: { email: 'hana@i-persons.com', name: 'Hana', handle: 'hana', display: 'i-Hana', phone: '+12025550102', locale: 'en', tz: 'Europe/Berlin', country: 'DE', currency: 'EUR', gender: 'woman', age: '45-54' },
  sara: { email: 'sara@i-persons.com', name: 'Sara', handle: 'sara', display: 'i-Sara', phone: '+12025550105', locale: 'en', tz: 'Europe/Berlin', country: 'DE', currency: 'EUR', gender: 'woman', age: '18-24' },
  giga: { email: 'giga@i-persons.com', name: 'Giga', handle: 'giga', display: 'i-Giga', phone: '+12025550103', locale: 'ar', tz: 'Africa/Tunis', country: 'TN', currency: 'TND', gender: 'woman', age: '65+' },
} as const;
export type PersonaId = keyof typeof PERSONAS;
/** A throw-away demo account the screenshot script walks through setup as Giga (deleted afterwards). */
export const GIGA_SETUP_EMAIL = 'video-giga-setup@example.com';
/** The demo café partner (made up): its console is shown as its staff member, Lina. */
export const CAFE = { slug: 'demo-cafe', name: 'Café Lumière', staffEmail: 'video-cafe@example.com', staffName: 'Lina', staffPhone: '+12025550106' } as const;

/** AI-generated faces of people who don't exist (Muse Image), used as "selfies". Never a real person's photo. */
export const AI_FACES: Partial<Record<PersonaId, { file: string; prompt: string; pick: number; restyle?: string }>> = {
  adam: {
    file: 'video-demo-adam-ai-face.jpg', pick: 0, // 0 = the 3D animated style
    prompt: 'Photorealistic front-facing head-and-shoulders photo of a fictional, AI-generated man in his late thirties (not a real person), North African features, short neat dark beard, black rectangular glasses, short dark hair, navy crew-neck sweater, friendly calm expression with the mouth closed, plain light-grey background, soft daylight.',
  },
  giga: {
    file: 'video-demo-giga-ai-face.jpg', pick: 1, // 1 = the painted style, then a clearer painted look in words
    restyle: 'Make it a warm hand-painted portrait with visible soft brush strokes, like an oil painting, clearly a painting and not a photo',
    prompt: 'Photorealistic front-facing head-and-shoulders photo of a fictional, AI-generated Tunisian grandmother around eighty (not a real person), kind eyes, soft smile lines, grey hair partly covered by a light cream headscarf, a dark green cardigan, mouth closed, plain light-grey background, soft daylight.',
  },
};

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() + n * DAY);
/** The next given weekday (0 = Sunday) at least 2 days ahead, as YYYY-MM-DD. */
export function nextWeekday(dow: number, minAhead = 2): string {
  const d = new Date(Date.now() + minAhead * DAY);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

type Fact = { category: 'preference' | 'routine' | 'goal' | 'constraint' | 'contact'; key: string; value: string; visibility?: 'public' | 'private' };

function facts(id: PersonaId): Fact[] {
  const sunday = nextWeekday(0);
  if (id === 'adam') return [
    { category: 'preference', key: 'work', value: 'Mechanical engineer, designs machine parts for a manufacturer in Berlin', visibility: 'public' },
    { category: 'preference', key: 'skills', value: 'CAD, tolerance analysis, working with suppliers', visibility: 'public' },
    { category: 'contact', key: 'supplier', value: 'Main supplier contact: Jonas, at supplier@example.com (parts for the new housing)' },
    { category: 'preference', key: 'drawings', value: 'The new drawings (revision C of the housing) are shared at https://example.com/drawings/housing-rev-c' },
    { category: 'preference', key: 'travel_style', value: 'Hotels near the station, 4 stars, always free cancellation' },
    { category: 'routine', key: 'munich', value: 'Visits the Munich plant every few weeks, usually 2 nights' },
    { category: 'contact', key: 'wife', value: `Wife: Hana, at ${PERSONAS.hana.email}` },
    { category: 'contact', key: 'mother', value: `Mother: Giga, lives in Sfax, at ${PERSONAS.giga.email}` },
    { category: 'contact', key: 'daughter', value: `Daughter: Sara, studies architecture in Berlin, at ${PERSONAS.sara.email}` },
    { category: 'preference', key: 'hana_likes', value: 'Hana loves dark chocolate' },
  ];
  if (id === 'hana') return [
    { category: 'preference', key: 'work', value: 'Product designer at a studio in Berlin', visibility: 'public' },
    { category: 'preference', key: 'coffee', value: 'Loves good coffee and long walks along the canal', visibility: 'public' },
    { category: 'contact', key: 'family', value: 'Husband: Adam. Daughter: Sara. Mother-in-law: Giga, in Sfax' },
    { category: 'preference', key: 'languages', value: 'Speaks French and English', visibility: 'public' },
    { category: 'preference', key: 'usual_coffee', value: 'Usual coffee: Espresso capsules, intense, 50 pack, from ShopMate' },
    { category: 'routine', key: 'evenings', value: 'Usually free on weekday evenings after 6 pm' },
  ];
  if (id === 'sara') return [
    { category: 'preference', key: 'work', value: 'Architecture student in Berlin', visibility: 'public' },
    { category: 'preference', key: 'coffee', value: 'Espresso, and cafés with a terrace by the canal', visibility: 'public' },
    { category: 'contact', key: 'family', value: 'Mother: Hana. Father: Adam. Grandmother: Giga, in Sfax' },
    { category: 'routine', key: 'evenings', value: 'Free after classes, around 6 pm' },
  ];
  return [
    { category: 'preference', key: 'origin', value: 'Born and married in Sfax, still lives there; her son Adam lives in Berlin', visibility: 'public' },
    { category: 'contact', key: 'family', value: 'Son: Adam; daughter-in-law: Hana; granddaughter: Sara (all in Berlin); daughter Leila and son Karim in Sfax' },
    { category: 'preference', key: 'photos', value: 'Loves old family photos and keeps every picture of her grandchildren', visibility: 'public' },
    { category: 'preference', key: 'music', value: 'Loves Malouf music and the smell of jasmine', visibility: 'public' },
    { category: 'preference', key: 'gift_wish', value: 'Has said she would love a new album for the family photos', visibility: 'public' },
    { category: 'goal', key: 'birthday', value: `Turns 81 on Sunday ${sunday}; wants a family lunch at home at 1 pm` },
    { category: 'constraint', key: 'language', value: 'Prefers to speak Tunisian Arabic' },
  ];
}

const RULES: Record<PersonaId, { kind: 'do' | 'dont'; text: string }[]> = {
  adam: [{ kind: 'do', text: 'Always sign emails with my first name' }, { kind: 'dont', text: 'Never book meetings before 9 am' }],
  hana: [{ kind: 'do', text: 'Answer me in the language I write in (French or English)' }, { kind: 'dont', text: 'Never share my phone number' }],
  sara: [{ kind: 'dont', text: 'No meetings before 9 am' }, { kind: 'dont', text: 'Never share my phone number' }],
  giga: [{ kind: 'do', text: 'Always speak to me in Tunisian Arabic' }, { kind: 'dont', text: 'Never share my phone number' }],
};

/** Giga's family: the three demo twins plus two made-up relatives (reserved addresses: never emailed). */
const FAMILY = [
  ['Adam', 'son', PERSONAS.adam.email], ['Hana', 'daughter-in-law', PERSONAS.hana.email], ['Sara', 'granddaughter', PERSONAS.sara.email],
  ['Leila', 'daughter', 'leila@example.org'], ['Karim', 'son', 'karim@example.org'],
] as const;

/** The neutral demo services in the Store catalog (only demo accounts see them). Idempotent. */
export async function ensureDemoConnectors(db: Db) {
  const caps: Record<string, string[]> = {
    stayfinder: ['Learn how you travel', 'Find stays like your last ones', 'Prepare a prefilled search'],
    flynow: ['Learn the routes you fly', 'Find fares', 'Prepare a prefilled search'],
    shopmate: ['Learn your usual orders', 'Remind you before you run out', 'Prepare your basket'],
  };
  const out: Record<string, string> = {};
  for (const [i, s] of DEMO_SERVICES.entries()) {
    const values = {
      slug: s.slug, name: s.name, type: 'mail' as const, category: s.category, tagline: s.tagline, iconUrl: s.icon,
      longDescription: `${s.name} is a demo service on i-persons: sample data, nothing is booked or bought.`,
      capabilities: caps[s.id]!, scopes: [{ id: s.category === 'travel' ? 'read_bookings' : 'read_orders', label: s.category === 'travel' ? 'Read your bookings' : 'Read your orders', description: `Confirmation emails from ${s.name} only`, required: true }, { id: 'suggest', label: 'Suggest', description: 'Suggest options and prepare links for you' }],
      senderDomains: [], featured: false, sortOrder: 10 + i, verified: true, live: true,
    };
    const [row] = await db.insert(connectors).values(values).onConflictDoUpdate({ target: connectors.slug, set: values }).returning();
    out[s.id] = row!.id;
  }
  return out;
}

/** Signs in as a user for app.inject calls. */
const cookieFor = (app: FastifyInstance, userId: string) => `ip_session=${app.jwt.sign({ sub: userId })}`;

/** Makes (or finds) one AI face, saved in UPLOAD_DIR, charged to the demo user. */
export async function aiFace(deps: AppDeps, userId: string, id: PersonaId): Promise<Buffer> {
  const f = AI_FACES[id]!;
  const path = join(config.UPLOAD_DIR, f.file);
  if (existsSync(path)) return readFile(path);
  // The faces used for the drafts are kept in the repo, so the live run uses the same (AI-generated) people.
  const kept = new URL(`./video-assets/${f.file}`, import.meta.url).pathname;
  if (existsSync(kept)) {
    const img = await readFile(kept);
    await writeFile(path, img);
    return img;
  }
  if (!deps.avatar) throw new Error('No META_API_KEY: AI faces need Muse Image');
  const img = await deps.avatar.generate(f.prompt);
  await charge(deps.db, userId, { kind: 'image', model: config.META_IMAGE_MODEL ?? 'muse-image-1.0', images: 1 });
  await writeFile(path, img);
  return img;
}

/** Selfie upload through the app (the same route the web uses). Returns the generated options. */
export async function uploadSelfie(app: FastifyInstance, userId: string, ipersonId: string, photo: Buffer) {
  const b = `----video${randomBytes(6).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="source"\r\n\r\nfile\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="selfie.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    photo, Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const r = await app.inject({ method: 'POST', url: `/ipersons/${ipersonId}/avatar/selfie`, headers: { cookie: cookieFor(app, userId), 'content-type': `multipart/form-data; boundary=${b}` }, payload: body });
  if (r.statusCode !== 200) throw new Error(`selfie upload failed: ${r.statusCode} ${r.body.slice(0, 200)}`);
  return r.json() as { options: string[]; mouths: ({ x: number; y: number; w: number } | null)[] };
}

async function makeAvatar(app: FastifyInstance, deps: AppDeps, userId: string, ipersonId: string, id: PersonaId, log: (s: string) => void) {
  const f = AI_FACES[id]!;
  const photo = await aiFace(deps, userId, id);
  const sel = await uploadSelfie(app, userId, ipersonId, photo);
  const k = Math.min(f.pick, sel.options.length - 1);
  const s = await app.inject({ method: 'POST', url: `/ipersons/${ipersonId}/avatar/select`, headers: { cookie: cookieFor(app, userId) }, payload: { url: sel.options[k], mouth: sel.mouths[k] ?? undefined, this_is_me: true } });
  if (s.statusCode !== 200) throw new Error(`avatar select failed: ${s.body.slice(0, 200)}`);
  if (f.restyle) {
    // The avatar studio's "change it in your own words", as a user would ask for it.
    const c = await app.inject({ method: 'POST', url: `/ipersons/${ipersonId}/avatar/customize`, headers: { cookie: cookieFor(app, userId) }, payload: { instruction: f.restyle } });
    if (c.statusCode !== 200) throw new Error(`avatar restyle failed: ${c.body.slice(0, 200)}`);
    const look = c.json() as { url: string; mouth?: { x: number; y: number; w: number } | null };
    await app.inject({ method: 'POST', url: `/ipersons/${ipersonId}/avatar/select`, headers: { cookie: cookieFor(app, userId) }, payload: { url: look.url, mouth: look.mouth ?? undefined, this_is_me: true } });
  }
  const life = await app.inject({ method: 'POST', url: `/ipersons/${ipersonId}/avatar/life`, headers: { cookie: cookieFor(app, userId) } });
  if (life.statusCode !== 200) throw new Error(`avatar life failed: ${life.body.slice(0, 200)}`);
  log(`${id}: avatar from an AI face (${k === f.pick ? (f.pick ? 'painted' : 'animated') : 'fallback'} style), ${8 - (life.json().missing ?? 0)} poses`);
}

/** Creates or refreshes the three demo accounts. `avatars`: make avatars that are missing (or all, with 'redo'). */
export async function seedVideoDemo(app: FastifyInstance, deps: AppDeps, opts: { avatars?: boolean | 'redo' | PersonaId[]; log?: (s: string) => void } = {}) {
  const { db } = deps;
  const log = opts.log ?? console.log;
  const svc = await ensureDemoConnectors(db);
  // The first drafts' "Med" persona (replaced by Adam) is retired; only ever a demo account on example.com.
  await db.delete(users).where(and(eq(users.email, 'video-med@example.com'), eq(users.accountKind, 'demo')));
  const ids = {} as Record<PersonaId, { userId: string; ipersonId: string }>;

  for (const id of Object.keys(PERSONAS) as PersonaId[]) {
    const p = PERSONAS[id];
    // The accounts were first made as video-<id>@example.com; they move to their own i-persons.com mailbox (Nov 1).
    await db.update(users).set({ email: p.email }).where(and(eq(users.email, `video-${id}@example.com`), eq(users.accountKind, 'demo')));
    let [user] = await db.select().from(users).where(eq(users.email, p.email));
    if (user && user.accountKind !== 'demo') throw new Error(`${p.email} exists and is not a demo account`);
    // A real phone linked by hand (for the WhatsApp shots) is kept; otherwise the fictional number.
    const phone = user?.phoneE164 && !isFictionalNumber(user.phoneE164) ? user.phoneE164 : p.phone;
    const base = {
      name: p.name, accountKind: 'demo', locale: p.locale, timezone: p.tz, country: p.country, currency: p.currency, signupCountry: p.country,
      gender: p.gender, ageRange: p.age, consentVersion: CONSENT_VERSION, consentAt: user?.consentAt ?? new Date(), setupStep: 'warmup',
      onboardedAt: user?.onboardedAt ?? new Date(), phoneE164: phone, phoneCountry: phone === p.phone ? 'US' : user?.phoneCountry, verifiedAt: user?.verifiedAt ?? new Date(),
      welcomedAt: user?.welcomedAt ?? new Date(), aiCreditMicros: Math.max(user?.aiCreditMicros ?? 0, usdToMicros(15)),
      emailVerifiedAt: user?.emailVerifiedAt ?? new Date(), pendingApprovalAt: null,
    } satisfies Partial<typeof users.$inferInsert>;
    [user] = user
      ? await db.update(users).set(base).where(eq(users.id, user.id)).returning()
      : await db.insert(users).values({ email: p.email, ...base }).returning();
    const userId = user!.id;

    const [taken] = await db.select({ userId: ipersons.userId }).from(ipersons).where(and(eq(ipersons.handle, p.handle), ne(ipersons.userId, userId)));
    if (taken) throw new Error(`@${p.handle} already belongs to another account`);
    const twin = {
      displayName: p.display, handle: p.handle, publicEnabled: true, visitorAllow: { answer: true, messages: true, meetings: true },
      visitorBudgetMicros: 2_000_000,
      publicBio: { adam: 'Mechanical engineer in Berlin. (Demo persona.)', hana: 'Product designer in Berlin, coffee lover. (Demo persona.)', sara: 'Architecture student in Berlin. (Demo persona.)', giga: 'A grandmother from Sfax who loves her family. (Demo persona.)' }[id],
      publicGreeting: `Hi, I’m ${p.name}’s i-person. Ask me about ${p.name}, or ask to meet ${id === 'adam' ? 'him' : 'her'}.`,
    };
    let [ip] = await db.select().from(ipersons).where(eq(ipersons.userId, userId));
    [ip] = ip ? await db.update(ipersons).set(twin).where(eq(ipersons.id, ip.id)).returning() : await db.insert(ipersons).values({ userId, ...twin }).returning();
    const ipersonId = ip!.id;
    ids[id] = { userId, ipersonId };

    // Scene state from earlier runs goes; the seeded history comes back below.
    await db.delete(conversations).where(eq(conversations.ipersonId, ipersonId));
    await db.delete(visitorConversations).where(eq(visitorConversations.ipersonId, ipersonId));
    await db.delete(actions).where(eq(actions.ipersonId, ipersonId));
    await db.delete(planSessions).where(eq(planSessions.creatorId, userId));
    await db.delete(twinConnections).where(or(eq(twinConnections.requesterId, userId), eq(twinConnections.recipientId, userId)));
    await db.delete(partnerRequests).where(eq(partnerRequests.userId, userId));
    await db.delete(partnerMatches).where(eq(partnerMatches.userId, userId));
    await db.delete(calendarEvents).where(eq(calendarEvents.ipersonId, ipersonId));
    await db.delete(profileFacts).where(eq(profileFacts.ipersonId, ipersonId));
    for (const f of facts(id)) await db.insert(profileFacts).values({ ipersonId, category: f.category, key: f.key, value: f.value, visibility: f.visibility ?? 'private', source: 'user_edit', confidence: 0.95 });
    await db.delete(ipersonRules).where(eq(ipersonRules.ipersonId, ipersonId));
    await db.insert(ipersonRules).values(RULES[id].map((r) => ({ ipersonId, ...r, source: 'onboarding' as const })));
    await db.delete(sourcePrefs).where(eq(sourcePrefs.ipersonId, ipersonId));
    await db.insert(sourcePrefs).values([
      { ipersonId, category: 'travel', provider: 'stayfinder', rank: 1 }, { ipersonId, category: 'travel', provider: 'flynow', rank: 2 },
      { ipersonId, category: 'shopping', provider: 'shopmate', rank: 1 },
    ]);

    // Services, orders and bookings (all on the demo services; refs DEMO-…).
    await db.delete(userServices).where(eq(userServices.userId, userId));
    const active = id === 'adam' ? ['stayfinder', 'flynow', 'shopmate'] : id === 'hana' ? ['shopmate'] : [];
    for (const s of active) {
      const travel = s !== 'shopmate';
      await db.insert(userServices).values({ userId, connectorId: svc[s]!, grantedScopes: [travel ? 'read_bookings' : 'read_orders', 'suggest'], statusLine: 'Up to date' });
    }
    await db.delete(purchases).where(and(eq(purchases.userId, userId), like(purchases.providerRef, 'DEMO-%')));
    await db.delete(bookings).where(and(eq(bookings.userId, userId), like(bookings.providerRef, 'DEMO-%')));
    await db.delete(insights).where(eq(insights.userId, userId));
    if (id === 'adam') {
      for (const [i, ago] of [[1, 120], [2, 78], [3, 41], [4, 12]] as const) {
        await db.insert(bookings).values({ userId, connectorId: svc.stayfinder, providerRef: `DEMO-SF-${i}`, kind: 'hotel', title: '4★ hotel by Munich Central Station', city: 'Munich', country: 'Germany', stars: 4, nights: 2, startAt: day(-ago), endAt: day(-ago + 2), bookedAt: day(-ago - 7), freeCancellation: true, amountCents: 23600, currency: 'EUR' });
      }
      for (const [i, ago] of [[1, 120], [2, 78], [3, 41]] as const) {
        await db.insert(bookings).values({ userId, connectorId: svc.flynow, providerRef: `DEMO-FN-${i}`, kind: 'flight', title: 'FlyNow BER → MUC', routeFrom: 'BER', routeTo: 'MUC', startAt: day(-ago), bookedAt: day(-ago - 9), amountCents: 14900, currency: 'EUR' });
      }
      for (const [i, ago] of [[1, 70], [2, 35]] as const) {
        await db.insert(purchases).values({ userId, connectorId: svc.shopmate, providerRef: `DEMO-SM-${i}`, merchant: 'ShopMate', title: 'Drawing pens, set of 8', itemRef: 'SMPENS0008', category: 'office', amountCents: 1290, currency: 'EUR', orderedAt: day(-ago) });
      }
    }
    if (id === 'hana') {
      for (const [i, ago] of [[1, 150], [2, 114], [3, 79], [4, 44], [5, 9]] as const) {
        await db.insert(purchases).values({ userId, connectorId: svc.shopmate, providerRef: `DEMO-SM-${i}`, merchant: 'ShopMate', title: 'Espresso capsules, intense, 50 pack', itemRef: 'SMCOFFEE50', category: 'coffee', amountCents: 1899, currency: 'EUR', orderedAt: day(-ago) });
      }
      await db.insert(purchases).values({ userId, connectorId: svc.shopmate, providerRef: 'DEMO-SM-9', merchant: 'ShopMate', title: 'Sketchbook A5, dotted', category: 'office', amountCents: 990, currency: 'EUR', orderedAt: day(-20) });
    }
    const learned = await refreshInsights(deps, userId);

    // People: the family has each other (matched to their accounts), plus people not on i-persons (reserved addresses).
    await db.delete(contacts).where(eq(contacts.userId, userId));
    const people: [string, string, string, string][] = id === 'adam'
      ? [['Hana', 'family', 'wife', PERSONAS.hana.email], ['Sara', 'family', 'daughter', PERSONAS.sara.email], ['Giga', 'family', 'mother', PERSONAS.giga.email], ['Jonas', 'business', 'supplier contact (parts for the new housing)', 'supplier@example.com']]
      : id === 'giga' ? FAMILY.map(([n, label, mail]) => [n, 'family', label, mail])
      : id === 'hana' ? [['Adam', 'family', 'husband', PERSONAS.adam.email], ['Sara', 'family', 'daughter', PERSONAS.sara.email], ['Giga', 'family', 'mother-in-law', PERSONAS.giga.email], ['Camille', 'colleague', 'colleague at the studio', 'camille@example.org']]
      : [['Hana', 'family', 'mother', PERSONAS.hana.email], ['Adam', 'family', 'father', PERSONAS.adam.email], ['Giga', 'family', 'grandmother', PERSONAS.giga.email], ['Theo', 'friend', 'friend from university', 'theo@example.org']];
    for (const [name, relationship, label, mail] of people) {
      await db.insert(contacts).values({ userId, key: mail, name, emails: [mail], relationship, label, inAddressBook: true, notes: `${label} (demo contact)` });
    }

    // History: a few things done earlier in the week, so Activity isn't empty.
    const past = (n: number) => day(-n);
    const hist = id === 'adam' ? [['calendar_book', 'Book "Design review" on Monday 10:00 at the office', 3], ['send_email', 'Email Jonas the updated part list', 2], ['prepare_checkout', 'Prepare StayFinder: hotels in Munich, 2 nights, 4★', 4], ['calendar_book', 'Book "Call with the plant" on Wednesday 14:00', 1]]
      : id === 'hana' ? [['calendar_book', 'Book "Yoga" on Tuesday 19:00', 4]]
      : id === 'sara' ? [['calendar_book', 'Book "Site visit" on Monday 11:00', 3]]
      : [['calendar_book', 'Book "Doctor’s visit" on Wednesday 10:30', 5]];
    for (const [tool, summary, ago] of hist as [string, string, number][]) {
      await db.insert(actions).values({ ipersonId, tool, args: {}, risk: 'write', status: 'done', summary, result: { booked: true }, confirmToken: `hist_${randomBytes(9).toString('hex')}`, expiresAt: past(ago), createdAt: past(ago), decidedAt: past(ago) });
    }

    // Avatars: Hana and Sara from the neutral library; Adam and Giga made by the app from AI-generated faces.
    if (id === 'hana' || id === 'sara') {
      const lib = await db.select().from(avatarAssets).where(and(eq(avatarAssets.library, true), eq(avatarAssets.variant, 'base'), eq(avatarAssets.gender, 'woman'), eq(avatarAssets.ageRange, p.age))).orderBy(avatarAssets.createdAt);
      const a = lib[1] ?? lib[0];
      if (a) await db.update(ipersons).set({ avatarUrl: a.imageUrl, avatarAssetId: a.id, avatarMeta: { mouth: (a.masks as { mouth?: unknown } | null)?.mouth } }).where(eq(ipersons.id, ipersonId));
      else log(`${id}: NO LIBRARY AVATAR (import the neutral library first)`);
    } else {
      const fresh = (await db.select().from(ipersons).where(eq(ipersons.id, ipersonId)))[0]!;
      const hasLife = fresh.avatarAssetId && (await db.select({ id: avatarAssets.id }).from(avatarAssets).where(eq(avatarAssets.lookId, fresh.avatarAssetId))).length > 1;
      const redo = opts.avatars === 'redo' || (Array.isArray(opts.avatars) && opts.avatars.includes(id));
      if (redo || (opts.avatars && !hasLife)) await makeAvatar(app, deps, userId, ipersonId, id, log);
      else if (!hasLife) {
        // A local install without --avatars: a starter library look of the same gender and age, so the twin can be used.
        const [a] = await db.select().from(avatarAssets).where(and(eq(avatarAssets.library, true), eq(avatarAssets.variant, 'base'), eq(avatarAssets.gender, p.gender), eq(avatarAssets.ageRange, p.age))).orderBy(avatarAssets.createdAt);
        if (a && !fresh.avatarUrl) await db.update(ipersons).set({ avatarUrl: a.imageUrl, avatarAssetId: a.id, avatarMeta: { mouth: (a.masks as { mouth?: unknown } | null)?.mouth } }).where(eq(ipersons.id, ipersonId));
        log(`${id}: ${a ? 'library avatar for now' : 'no avatar yet'} (run with --avatars for the one made from the AI face)`);
      }
    }
    log(`${id}: ${p.email}, @${p.handle}, ${learned.length} insights`);
  }
  await seedFriends(db, ids, log);
  await seedCafe(db, ids, log);
  return ids;
}

/** Hana and Sara (mother and daughter): matched contacts, connected twins (plan, availability, preferences) and next week's calendars. */
async function seedFriends(db: Db, ids: Record<PersonaId, { userId: string; ipersonId: string }>, log: (s: string) => void) {
  const { hana, sara } = ids;
  for (const u of Object.values(ids)) await refreshIdentifiers(db, u.userId);
  for (const u of Object.values(ids)) await matchContacts(db, u.userId);
  const share = async (ip: string, key: string, value: string) => upsertFact(db, ip, { category: 'preference', key, value, source: 'user_edit' });
  const hanaFacts = [await share(hana.ipersonId, 'coffee_place', 'Quiet cafés with good espresso, near the canal')];
  const saraFacts = [await share(sara.ipersonId, 'coffee_place', 'Terraces by the canal')];
  const scopes = ['plan', 'availability', 'preferences', 'suggest'];
  await db.insert(twinConnections).values({
    requesterId: sara.userId, recipientId: hana.userId, status: 'active', requesterScopes: scopes, recipientScopes: scopes,
    requesterFactIds: saraFacts.map((f) => f.id), recipientFactIds: hanaFacts.map((f) => f.id), respondedAt: day(-20), createdAt: day(-21),
  });
  // Next week (Monday on): the first time both are free is Thursday 18:00.
  const mon = nextWeekday(1, 1);
  const at = (offset: number, hm: string) => parseLocal(`${new Date(Date.parse(mon) + offset * DAY).toISOString().slice(0, 10)}T${hm}`, PERSONAS.hana.tz);
  const ev = (ipersonId: string, title: string, d: number, from: string, to: string) => db.insert(calendarEvents).values({ ipersonId, title, startsAt: at(d, from), endsAt: at(d, to) });
  // Hana is away Monday to Wednesday and busy until Thursday 18:00, whatever time of day Sara's twin asks for.
  for (const d of [0, 1, 2]) await ev(hana.ipersonId, 'Design fair in Munich', d, '00:00', '23:59');
  await ev(hana.ipersonId, 'Studio deadline', 3, '00:00', '18:00');
  await ev(sara.ipersonId, 'Site visit', 0, '11:00', '13:00');
  await ev(sara.ipersonId, 'Swimming', 4, '18:00', '20:00');
  log(`hana + sara: connected twins; next week from ${mon}, first shared free evening is Thursday 18:00`);
}

/**
 * Café Lumière, a made-up café partner (slug demo-…, so only demo accounts see it): three venues in Berlin
 * (offered for demo plans instead of real places), Lina as its console member, and the demo twins opted in.
 */
async function seedCafe(db: Db, ids: Record<PersonaId, { userId: string; ipersonId: string }>, log: (s: string) => void) {
  const scopes = [
    { id: 'receive_offers', label: 'Receive deals and events', required: true, description: `${CAFE.name} may propose deals and events to me` },
    { id: 'public_profile', label: 'Talk to my twin', required: false, description: `${CAFE.name}'s assistant may talk to my twin about my public facts` },
    { id: 'requests', label: 'Ask me for things', required: false, description: `${CAFE.name} may ask me to reserve a seat (I always approve)` },
  ];
  const store = {
    name: CAFE.name, type: 'org' as const, category: 'other' as const, badge: 'demo', tagline: 'Specialty coffee by the canal (demo partner)',
    longDescription: `${CAFE.name} is a made-up café for the demo: it posts tastings and deals, and asks for a reservation only with your yes.`,
    capabilities: ['Proposes tastings and deals that fit you', 'Asks for a reservation only with your OK'], scopes, verified: true, live: true, sortOrder: 15,
  };
  const [c] = await db.insert(connectors).values({ slug: CAFE.slug, ...store }).onConflictDoUpdate({ target: connectors.slug, set: store }).returning();
  const manifest = { name: CAFE.name, tagline: store.tagline, category: 'other', capabilities: store.capabilities, user_scopes: scopes.map((s) => s.id), offer_types: ['deal', 'event', 'venue'] };
  let [p] = await db.select().from(partners).where(eq(partners.slug, CAFE.slug));
  p ??= (await db.insert(partners).values({ slug: CAFE.slug, name: CAFE.name, website: 'https://example.com', scopes: PARTNER_SCOPES.filter((s) => s !== 'webhooks:manage'), connectorId: c!.id, manifest, verified: true }).returning())[0]!;
  await db.delete(partnerOffers).where(eq(partnerOffers.partnerId, p.id));
  const venues = ['Café Lumière, Landwehrkanal', 'Café Lumière, Mitte', 'Café Lumière, Prenzlauer Berg'];
  for (const title of venues) {
    await db.insert(partnerOffers).values({ partnerId: p.id, type: 'venue', title, description: 'Specialty coffee, quiet tables, terrace. (Demo venue.)', location: `${title.split(', ')[1]}, Berlin`, requirements: { accepts_reservations: true }, validUntil: day(60) });
  }
  // Lina runs the café's console.
  let [staff] = await db.select().from(users).where(eq(users.email, CAFE.staffEmail));
  const base = { name: CAFE.staffName, accountKind: 'demo', locale: 'en', timezone: PERSONAS.hana.tz, consentVersion: CONSENT_VERSION, consentAt: new Date(), onboardedAt: new Date(), setupStep: 'warmup', phoneE164: CAFE.staffPhone, phoneCountry: 'US', verifiedAt: new Date(), pendingApprovalAt: null };
  [staff] = staff ? await db.update(users).set(base).where(eq(users.id, staff.id)).returning() : await db.insert(users).values({ email: CAFE.staffEmail, ...base }).returning();
  await db.insert(partnerMembers).values({ partnerId: p.id, userId: staff!.id, role: 'owner' }).onConflictDoNothing();
  for (const id of ['hana', 'sara', 'giga', 'adam'] as PersonaId[]) {
    await db.delete(userServices).where(and(eq(userServices.userId, ids[id].userId), eq(userServices.connectorId, c!.id)));
    await db.insert(userServices).values({ userId: ids[id].userId, connectorId: c!.id, grantedScopes: scopes.map((s) => s.id), statusLine: 'Connected' });
  }
  log(`${CAFE.name}: ${venues.length} demo venues, console /console/${CAFE.slug} for ${CAFE.staffEmail}`);
}

/** Everything the Meta models cost for the demo accounts so far (Meta's price, no platform fee). */
export async function demoSpendUsd(db: Db): Promise<number> {
  const demo = await db.select({ id: users.id }).from(users).where(inArray(users.email, [...Object.values(PERSONAS).map((p): string => p.email), GIGA_SETUP_EMAIL, CAFE.staffEmail]));
  if (!demo.length) return 0;
  const { aiUsage } = await import('../src/db/schema.ts');
  const rows = await db.select({ c: aiUsage.metaCostMicros }).from(aiUsage).where(inArray(aiUsage.userId, demo.map((d) => d.id)));
  return rows.reduce((n, r) => n + r.c, 0) / 1e6;
}
