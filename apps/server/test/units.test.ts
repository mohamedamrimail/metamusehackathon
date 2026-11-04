import { describe, expect, it } from 'vitest';
import { confirmIntent } from '../src/agent/confirm-intent.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { parseSamBox } from '../src/meta/image.ts';
import { parseLocal, toLocalIso } from '../src/lib/time.ts';

describe('confirmIntent', () => {
  it.each(['yes', 'Yes please!', 'ok', 'Oui, vas-y', 'oui vas-y', 'نعم', 'behi', 'go ahead.'])('%s → yes', (t) => {
    expect(confirmIntent(t)).toBe('yes');
  });
  it.each(['no', 'Non merci', 'لا', 'cancel'])('%s → no', (t) => expect(confirmIntent(t)).toBe('no'));
  it.each(['yes but make it 7pm', 'book yoga', 'okay what about friday'])('%s → null', (t) => {
    expect(confirmIntent(t)).toBeNull();
  });
});

describe('time', () => {
  it('reads times without offset in the user timezone', () => {
    expect(parseLocal('2026-11-04T18:00', 'Africa/Tunis').toISOString()).toBe('2026-11-04T17:00:00.000Z');
    expect(parseLocal('2026-07-04T18:00:00', 'Europe/Paris').toISOString()).toBe('2026-07-04T16:00:00.000Z');
    expect(parseLocal('2026-11-04T18:00:00Z', 'Africa/Tunis').toISOString()).toBe('2026-11-04T18:00:00.000Z');
  });
  it('formats with the zone offset', () => {
    expect(toLocalIso(new Date('2026-11-04T17:00:00Z'), 'Africa/Tunis')).toBe('2026-11-04T18:00:00+01:00');
  });
});

describe('demo model booking', () => {
  const book = async (text: string) => {
    const r = await new DemoLlm(() => new Date('2026-10-29T12:00:00Z')).complete({
      messages: [{ role: 'user', content: text }],
      tools: [{ name: 'calendar_book', description: '', parameters: {} }],
    });
    return JSON.parse(r.toolCalls[0]!.arguments) as { title: string; start: string; location?: string };
  };
  it('books what was asked for, not a generic class', async () => {
    expect(await book('Book table tennis for sunday')).toMatchObject({ title: 'Table tennis', start: '2026-11-01T18:00' });
    expect((await book('book yoga thursday at 7pm')).title).toBe('Yoga');
    expect(await book('Book a haircut at Salon Ali on friday 5pm')).toMatchObject({ title: 'Haircut', location: 'Salon Ali', start: '2026-10-30T17:00' });
    expect((await book('Book table tennis for sunday')).location).toBeUndefined();
  });
});

describe('SAM output', () => {
  it('turns the first box into a mouth position', () => {
    // Real output for "mouth" on a 1600×1600 avatar.
    expect(parseSamBox('<0f>0<|box;x1=647;y1=1046;x2=947;y2=1127;w=1600;h=1600|><|mask;abc|>')).toEqual({ x: 0.498125, y: 0.6790625, w: 0.1875 });
    expect(parseSamBox('')).toBeNull();
  });
});


describe('mailer: never mails reserved (made-up) addresses', async () => {
  const { isReservedAddress, realRecipients } = await import('../src/lib/mailer.ts');
  it('drops example.com/.org/.net and *.test/.example/.invalid/.localhost, keeps real ones', () => {
    for (const a of ['sami@example.org', 'x@example.com', 'Name <y@example.net>', 'a@sub.example.com', 'b@foo.test', 'c@x.invalid', 'd@host.localhost', 'e@shop.example']) expect(isReservedAddress(a)).toBe(true);
    for (const a of ['hana@i-persons.com', 'me@examples.com', 'me@example.co', 'friend@gmail.com']) expect(isReservedAddress(a)).toBe(false);
    expect(realRecipients('a@example.org, hana@i-persons.com')).toEqual(['hana@i-persons.com']);
    expect(realRecipients([{ name: 'X', address: 'x@example.com' }, 'y@gmail.com'])).toEqual(['y@gmail.com']);
    expect(realRecipients(undefined)).toEqual([]);
  });
});

describe('family words', () => {
  it('maps what people say to the contact label', async () => {
    const { kinLabel } = await import('../src/lib/kin.ts');
    expect(kinLabel('my mom')).toBe('mother');
    expect(kinLabel('Mum')).toBe('mother');
    expect(kinLabel('grandma')).toBe('grandmother');
    expect(kinLabel('my dad’s')).toBe('father');
    expect(kinLabel('Hana')).toBeUndefined();
  });
});
