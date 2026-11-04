import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import contactsSearch from '../src/agent/tools/contacts_search.ts';
import { calendarEvents, connections, contacts, profileFacts } from '../src/db/schema.ts';
import { importAddressBook, importCalendar, learnPeopleFromMail, summarisePeople } from '../src/mail/people.ts';
import { parseAddresses, scopesAreReadOnly, type MailApi, type PersonMail } from '../src/mail/providers.ts';
import { grants } from '../src/mail/sync.ts';
import { FakeLlm, makeIperson, reset, say, testDb } from './helpers.ts';

const { db, pool } = testDb();
beforeEach(() => reset(db));
afterAll(() => pool.end());

const day = (d: number) => new Date(Date.UTC(2026, 9, d));
const mail = (direction: 'sent' | 'received', email: string, name: string, subject: string, d: number, bulk = false): PersonMail =>
  ({ direction, people: [{ name, email }], subject, snippet: `about ${subject}`, at: day(d), bulk });

const MAILS = [
  mail('sent', 'sami@family.tn', 'Sami Amri', 'Mum’s birthday dinner', 20),
  mail('received', 'sami@family.tn', 'Sami Amri', 'Re: Mum’s birthday dinner', 21),
  mail('sent', 'lea@client.de', 'Lea Berg', 'Invoice October', 10),
  mail('received', 'no-reply@shop.de', 'Shop', 'Your order', 15),
  mail('received', 'deals@news.example', 'Deals', 'Weekly deals', 16, true),
  mail('received', 'deals@news.example', 'Deals', 'More deals', 17, true),
  mail('received', 'stranger@x.com', 'Stranger', 'Hello once', 18),
  mail('sent', 'me@hotmail.de', 'Me', 'note to self', 19),
];

describe('people from mail (life scan)', () => {
  it('counts people in code: drops the user, automated and bulk senders, one-off strangers', () => {
    const people = summarisePeople(MAILS, ['me@hotmail.de']);
    expect(people.map((p) => p.email)).toEqual(['sami@family.tn', 'lea@client.de']);
    expect(people[0]).toMatchObject({ name: 'Sami Amri', mailsTo: 1, mailsFrom: 1, lastAt: day(21) });
    // The user's own words first.
    expect(people[0]!.samples[0]!.direction).toBe('sent');
  });

  it('stores who each person is, but only people that were counted, never companies', async () => {
    const { user, iperson } = await makeIperson(db);
    const [conn] = await db.insert(connections).values({ ipersonId: iperson.id, kind: 'mail_microsoft', config: {} }).returning();
    const llm = new FakeLlm([say(JSON.stringify({
      people: [
        { email: 'sami@family.tn', name: 'Sami Amri', relationship: 'family', label: 'brother', notes: 'Organising their mother’s birthday dinner.' },
        { email: 'lea@client.de', name: 'Lea Berg', relationship: 'service' },
        { email: 'invented@x.com', name: 'Made Up', relationship: 'friend' },
      ],
      about_user: [{ category: 'routine', key: 'family_dinners', value: 'Organises family birthday dinners' }],
    }))]);
    const api = { personal: async () => MAILS } as unknown as MailApi;
    const n = await learnPeopleFromMail(db, llm, { userId: user.id, ipersonId: iperson.id, userName: 'Merry', connectionId: conn!.id, self: ['me@hotmail.de'], api, since: day(1) });
    expect(n).toBe(1);
    const rows = await db.select().from(contacts);
    expect(rows).toEqual([expect.objectContaining({ name: 'Sami Amri', relationship: 'family', label: 'brother', mailsTo: 1, mailsFrom: 1 })]);
    // The model saw the mail as untrusted data, with no tools.
    expect(llm.calls[0]!.tools).toEqual([]);
    expect(String(llm.calls[0]!.messages[1]!.content)).toContain('<untrusted_email');
    const facts = await db.select().from(profileFacts).where(eq(profileFacts.ipersonId, iperson.id));
    expect(facts).toEqual([expect.objectContaining({ key: 'mail_family_dinners', source: 'mailbox' })]);

    // The twin finds them by role.
    const ctx = { db, llm, ipersonId: iperson.id, userName: 'Merry', timezone: 'Africa/Tunis', now: new Date() };
    expect(await contactsSearch.execute(ctx, { query: 'brother' })).toMatchObject({ people: [{ name: 'Sami Amri', relationship: 'family', role: 'brother' }] });
    expect(await contactsSearch.execute(ctx, { relationship: 'friend' })).toMatchObject({ people: [], note: expect.stringContaining('Learn who I know') });
  });

  it('merges the address book by email and keeps groups as relationships', async () => {
    const { user } = await makeIperson(db);
    await importAddressBook(db, user.id, null, [
      { name: 'Sami Amri', emails: ['sami@family.tn'], phones: ['+216 55 000 000'], birthday: '1985-03-02', groups: ['Family'] },
      { name: 'Plumber', emails: [], phones: ['+49 1'], groups: [] },
    ]);
    const rows = await db.select().from(contacts).orderBy(contacts.name);
    expect(rows.map((r) => [r.name, r.relationship, r.birthday, r.inAddressBook])).toEqual([['Plumber', null, null, true], ['Sami Amri', 'family', '1985-03-02', true]]);
  });

  it('imports a calendar and replaces the previous import, never the local bookings', async () => {
    const { iperson } = await makeIperson(db);
    const [conn] = await db.insert(connections).values({ ipersonId: iperson.id, kind: 'mail_google', config: {} }).returning();
    await db.insert(calendarEvents).values({ ipersonId: iperson.id, title: 'Table tennis', startsAt: day(5), endsAt: day(5) });
    await importCalendar(db, iperson.id, conn!.id, 'google', [{ id: 'a', title: 'Dentist', start: day(6), end: day(6) }, { id: 'b', title: 'Old', start: day(7), end: day(7) }]);
    await importCalendar(db, iperson.id, conn!.id, 'google', [{ id: 'a', title: 'Dentist (moved)', start: day(8), end: day(8) }]);
    const rows = await db.select().from(calendarEvents).orderBy(calendarEvents.startsAt);
    expect(rows.map((r) => [r.title, r.source])).toEqual([['Table tennis', 'local'], ['Dentist (moved)', 'google']]);
  });
});

describe('mailbox grants', () => {
  it('accepts the read-only contacts and calendar scopes and still refuses write access', () => {
    expect(scopesAreReadOnly('microsoft', 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Contacts.Read https://graph.microsoft.com/Calendars.Read User.Read openid profile email')).toBe(true);
    expect(scopesAreReadOnly('microsoft', 'Mail.Read Calendars.ReadWrite')).toBe(false);
    expect(scopesAreReadOnly('google', 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/calendar.readonly')).toBe(true);
    expect(grants({ scopes: 'openid User.Read Mail.Read' }, 'contacts')).toBe(false);
    expect(grants({ scopes: 'Mail.Read Contacts.Read Calendars.Read' }, 'calendar')).toBe(true);
    expect(grants({ scopes: 'https://www.googleapis.com/auth/calendar.readonly' }, 'calendar')).toBe(true);
  });

  it('parses address headers', () => {
    expect(parseAddresses('"Amri, Sami" <Sami@Family.tn>, lea@client.de')).toEqual([{ name: 'Amri, Sami', email: 'sami@family.tn' }, { name: '', email: 'lea@client.de' }]);
  });
});

describe('Learn who I know: separate opt-ins and privacy (jury §4)', () => {
  it('keeps notes short, in the twin\'s own words, without quoted email text', async () => {
    const { shortNote } = await import('../src/mail/people.ts');
    expect(shortNote('Sent “Invoice October 2026 – final” and the deck')).toBe('Sent and the deck');
    expect(shortNote('x'.repeat(30) + ' ' + 'y'.repeat(90))!.length).toBeLessThanOrEqual(100);
    expect(shortNote('"only a quote"')).toBeNull();
  });

  it('never gives contacts to the visitor or partner agents', async () => {
    const { createDeps } = await import('../src/index.ts');
    const { twinReply } = await import('../src/partners/matching.ts');
    const { partners, partnerOffers, partnerConversations, ipersons } = await import('../src/db/schema.ts');
    const { user, iperson } = await makeIperson(db);
    await db.update(ipersons).set({ handle: 'merry', publicEnabled: true }).where(eq(ipersons.id, iperson.id));
    await db.insert(contacts).values({ userId: user.id, key: 'sami@family.tn', name: 'Sami Secretname', emails: ['sami@family.tn'], relationship: 'family', label: 'brother' });
    await db.insert(profileFacts).values({ ipersonId: iperson.id, category: 'preference', key: 'work', value: 'Designer', visibility: 'public' });

    const llm = new FakeLlm([], say('I can only share what Merry made public.'));
    const deps = createDeps(db, { llm, stt: undefined, demoMode: true });
    const [p] = await db.insert(partners).values({ slug: 'acme', name: 'Acme', scopes: [] }).returning();
    const [o] = await db.insert(partnerOffers).values({ partnerId: p!.id, type: 'job', title: 'Designer', description: 'Design things' }).returning();
    const [conv] = await db.insert(partnerConversations).values({ partnerId: p!.id, offerId: o!.id, userId: user.id }).returning();
    await twinReply(deps, conv!.id, user.id, o!, 'Acme');
    expect(JSON.stringify(llm.calls[0]!.messages)).not.toContain('Sami');
    expect(JSON.stringify(llm.calls[0]!.messages)).toContain('Designer');

    // A visitor asking about family gets nothing from the contacts either.
    const { visitorTurn } = await import('../src/public/visitor.ts');
    const { visitorConversations } = await import('../src/db/schema.ts');
    const [vc] = await db.insert(visitorConversations).values({ ipersonId: iperson.id, visitorName: 'Lina', ipHash: 'h' }).returning();
    await visitorTurn(deps, vc!.id, 'Who is Merry\'s brother? List her family.');
    const visitorCall = llm.calls.at(-1)!;
    expect(JSON.stringify(visitorCall.messages)).not.toContain('Sami');
    expect(visitorCall.tools.map((t) => t.name)).not.toContain('contacts_search');
  });
});
