import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { suggestTwinNames } from '@ipersons/shared';
import { buildApp, createDeps } from '../src/index.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { checkReply } from '../src/agent/rules.ts';
import { pageText, pdfText, previewImage, robotsAllow } from '../src/agent/links.ts';
import addRule from '../src/agent/tools/add_rule.ts';
import sendWhatsapp from '../src/agent/tools/send_whatsapp.ts';
import { sendToOwner } from '../src/channels/whatsapp-client.ts';
import { identityFrom } from '../src/http/sign-in.ts';
import { ipersonRules, ipersons, profileFacts, users, wallets } from '../src/db/schema.ts';
import { config } from '../src/config.ts';
import { FakeLlm, makeIperson, reset, say, testDb, testGeo } from './helpers.ts';

const { db, pool } = testDb();
let app: FastifyInstance;

beforeEach(async () => {
  await reset(db);
  await app?.close();
  app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(() => new Date('2026-11-02T09:00:00Z')), stt: undefined, demoMode: true }));
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function signUp() {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'mohamed@example.com', password: 'correct horse', name: 'Mohamed Amri' } });
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const ip = await app.inject({ method: 'POST', url: '/api/ipersons', headers: { cookie }, payload: { display_name: 'i-Med', locale: 'en', timezone: 'Europe/Berlin' } });
  return { cookie, ipersonId: ip.json().iperson.id as string, userId: res.json().user.id as string };
}

describe('setup', () => {
  it('proposes twin names from the user’s name', async () => {
    expect(suggestTwinNames('Mohamed Amri')).toEqual(['i-Mohamed', 'i-Med', 'i-MA']);
    expect(suggestTwinNames('Sam')).toEqual(['i-Sam']);
    const { cookie } = await signUp();
    const res = await app.inject({ method: 'GET', url: '/api/me/twin-names', headers: { cookie } });
    expect(res.json().names).toContain('i-Med');
  });

  it('starts a twin without the mock dinar wallet, and saves country, currency and progress', async () => {
    const { cookie, ipersonId } = await signUp();
    expect(await db.select().from(wallets).where(eq(wallets.ipersonId, ipersonId))).toHaveLength(0);
    const p = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: { cookie }, payload: { country: 'DE', currency: 'EUR', locale: 'de' } });
    expect(p.json().user).toMatchObject({ country: 'DE', currency: 'EUR', locale: 'de', onboarded: false });
    const s = await app.inject({ method: 'PATCH', url: '/api/me/setup', headers: { cookie }, payload: { step: 'rules' } });
    expect(s.json().user.setup_step).toBe('rules');
    const bad = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: { cookie }, payload: { currency: 'XXX' } });
    expect(bad.statusCode).toBe(400);
  });

  it('keeps rules with their source; editing makes a rule the user’s own', async () => {
    const { cookie, ipersonId } = await signUp();
    const add = await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/rules`, headers: { cookie }, payload: {
      source: 'onboarding', rules: [{ kind: 'dont', text: 'Never book anything on Sundays' }, { kind: 'do', text: 'Answer briefly' }],
    } });
    expect(add.statusCode).toBe(201);
    const [first] = add.json().rules;
    expect(first.source).toBe('onboarding');
    const edit = await app.inject({ method: 'PATCH', url: `/api/ipersons/${ipersonId}/rules/${first.id}`, headers: { cookie }, payload: { text: 'Never book on Sundays or Fridays' } });
    expect(edit.json().rule).toMatchObject({ source: 'user', text: 'Never book on Sundays or Fridays' });
    await app.inject({ method: 'DELETE', url: `/api/ipersons/${ipersonId}/rules/${first.id}`, headers: { cookie } });
    expect((await app.inject({ method: 'GET', url: `/api/ipersons/${ipersonId}/rules`, headers: { cookie } })).json().rules).toHaveLength(1);
  });

  it('saves tapped interests as facts and ranks preferred sources per category', async () => {
    const { cookie, ipersonId } = await signUp();
    await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/interests`, headers: { cookie }, payload: { answers: { sport: ['Table tennis', 'Running'], work: [] } } });
    const facts = await db.select().from(profileFacts).where(eq(profileFacts.ipersonId, ipersonId));
    expect(facts.map((f) => [f.key, f.value])).toEqual([['interest_sport', 'Table tennis, Running']]);

    const put = await app.inject({ method: 'PUT', url: `/api/ipersons/${ipersonId}/sources`, headers: { cookie }, payload: { providers: ['skyscanner', 'amazon', 'booking'] } });
    expect(put.statusCode).toBe(200);
    const got = (await app.inject({ method: 'GET', url: `/api/ipersons/${ipersonId}/sources`, headers: { cookie } })).json().sources;
    expect(got.map((s: { provider: string; rank: number }) => `${s.provider}:${s.rank}`).sort()).toEqual(['amazon:1', 'booking:2', 'skyscanner:1']);
    const unknown = await app.inject({ method: 'PUT', url: `/api/ipersons/${ipersonId}/sources`, headers: { cookie }, payload: { providers: ['evil'] } });
    expect(unknown.statusCode).toBe(400);
  });

  it('rejects links that aren’t web addresses', async () => {
    const { cookie, ipersonId } = await signUp();
    const bad = await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/links`, headers: { cookie }, payload: { kind: 'website', url: 'file:///etc/passwd' } });
    expect(bad.statusCode).toBe(400);
  });

  it('ends setup with the twin’s first message and marks the user onboarded', async () => {
    const { cookie, ipersonId, userId } = await signUp();
    const res = await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/warmup`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBeTruthy();
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u!.onboardedAt).toBeTruthy();
  });

  it('deletes a password-less (Google/Microsoft) account with DELETE typed', async () => {
    const [u] = await db.insert(users).values({ email: 'g@example.com', name: 'G', passwordHash: null }).returning();
    await app.ready();
    const token = app.jwt.sign({ sub: u!.id });
    const cookie = `ip_session=${token}`;
    expect((await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie }, payload: { confirm: 'nope' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie }, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
  });
});

describe('sign-in with Google / Microsoft / Facebook', () => {
  const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

  it('takes the email and name from the id token, and refuses unverified Google emails', async () => {
    expect(await identityFrom('google', { access_token: 'a', id_token: jwt({ email: 'A@Gmail.com', email_verified: true, given_name: 'Amal' }) }))
      .toEqual({ email: 'a@gmail.com', name: 'Amal' });
    expect(await identityFrom('google', { access_token: 'a', id_token: jwt({ email: 'a@gmail.com', email_verified: false }) })).toBeNull();
    expect(await identityFrom('microsoft', { access_token: 'a', id_token: jwt({ preferred_username: 'md@hotmail.de', name: 'Mohamed' }) }))
      .toEqual({ email: 'md@hotmail.de', name: 'Mohamed' });
  });

  it('lists configured providers and sends unconfigured ones back to login', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/providers' });
    expect(res.json()).toMatchObject({ google: false, microsoft: true, facebook: false });
    const start = await app.inject({ method: 'GET', url: '/api/auth/oauth/google/start' });
    expect(start.headers.location).toBe('/login?error=provider_unavailable');
    const ms = await app.inject({ method: 'GET', url: '/api/auth/oauth/microsoft/start' });
    expect(ms.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\/.*scope=openid\+email\+profile/);
    const forged = await app.inject({ method: 'GET', url: '/api/auth/oauth/microsoft/callback?code=x&state=forged' });
    expect(forged.headers.location).toBe('/login?error=expired');
  });
});

describe('rules check (control agent)', () => {
  const rules = [{ id: 'r1', kind: 'dont' as const, text: 'Never book anything on Sundays' }];

  it('rewrites a reply that breaks a rule and names the rule', async () => {
    const llm = new FakeLlm([say('{"ok":false,"violated":[1],"rewrite":"[mood:sorry] Sundays are off-limits; how about Saturday?"}')]);
    const r = await checkReply(llm, rules, 'book tennis', '[mood:happy] Booked for Sunday!');
    expect(r).toEqual({ ok: false, reply: '[mood:sorry] Sundays are off-limits; how about Saturday?', violated: ['r1'] });
    expect(llm.calls[0]!.messages[1]!.content).toContain('DON’T: Never book anything on Sundays');
  });

  it('keeps the reply when it fits, when there are no rules, or when the checker fails', async () => {
    expect((await checkReply(new FakeLlm([say('{"ok":true}')]), rules, 'hi', 'Hello')).reply).toBe('Hello');
    const none = new FakeLlm([]);
    expect((await checkReply(none, [], 'hi', 'Hello')).reply).toBe('Hello');
    expect(none.calls).toHaveLength(0);
    expect((await checkReply(new FakeLlm([say('garbage')]), rules, 'hi', 'Hello')).ok).toBe(true);
  });

  it('add_rule saves a chat rule with where it came from', async () => {
    const { iperson } = await makeIperson(db);
    const ctx = { db, llm: new FakeLlm([]), ipersonId: iperson.id, userName: 'Merry', timezone: 'Africa/Tunis', now: new Date() };
    await addRule.execute(ctx, { kind: 'dont', text: 'Never call me before 9am', source: 'chat', why: 'User: "don’t ever call me before 9"' });
    const [row] = await db.select().from(ipersonRules).where(eq(ipersonRules.ipersonId, iperson.id));
    expect(row).toMatchObject({ kind: 'dont', source: 'chat', sourceNote: 'User: "don’t ever call me before 9"' });
  });
});

/** A tiny valid one-page PDF with the given text (offsets computed so pdftotext accepts it). */
function makePdf(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    (() => { const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`; return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`; })(),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('social profiles are never fetched (jury §5)', () => {
  it('honours robots.txt for our agent, else for everyone', () => {
    const robots = 'User-agent: *\nDisallow: /private\n\nUser-agent: i-persons\nDisallow: /\nAllow: /about\n';
    expect(robotsAllow(robots, '/about')).toBe(true);
    expect(robotsAllow(robots, '/blog')).toBe(false);
    expect(robotsAllow('User-agent: *\nDisallow: /private', '/private/x')).toBe(false);
    expect(robotsAllow('User-agent: *\nDisallow: /private', '/')).toBe(true);
    expect(robotsAllow('', '/')).toBe(true);
  });

  it('refuses social network links and learns from pasted LinkedIn text or the LinkedIn PDF', async () => {
    const { cookie, ipersonId } = await signUp();
    for (const url of ['https://www.linkedin.com/in/someone', 'https://instagram.com/x', 'https://m.facebook.com/p']) {
      const r = await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/links`, headers: { cookie }, payload: { kind: 'website', url } });
      expect(r.json().error).toBe('social_network');
    }
    expect((await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/links`, headers: { cookie }, payload: { kind: 'linkedin', url: 'https://example.com' } })).statusCode).toBe(400);

    const answer = say(JSON.stringify({ summary: 'Product designer in Berlin.', facts: [{ category: 'preference', key: 'job', value: 'Product designer' }] }));
    await app.close();
    app = buildApp(createDeps(db, { geo: testGeo, llm: new FakeLlm([answer, answer]), stt: undefined, demoMode: true }));
    const pasted = await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/linkedin`, headers: { cookie }, payload: { text: 'About: I design products in Berlin. Experience: Senior product designer at Acme since 2021.' } });
    expect(pasted.json()).toEqual({ learned: 1, summary: 'Product designer in Berlin.' });
    // The user's own words: saved right away, private.
    const [fact] = await db.select().from(profileFacts).where(eq(profileFacts.ipersonId, ipersonId));
    expect(fact).toMatchObject({ value: 'Product designer', status: 'active', visibility: 'private', source: 'link' });

    const pdf = makePdf('Senior product designer at Acme, Berlin, since 2021. Skills: Figma, React.');
    expect(await pdfText(pdf)).toContain('Senior product designer at Acme');
    const boundary = 'xyz';
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Profile.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), pdf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const up = await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/linkedin`, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(up.json()).toMatchObject({ learned: 1 });
  });
});

describe('links', () => {
  it('reads visible text and meta descriptions, never scripts', () => {
    const t = pageText('<head><meta name="description" content="Founder of Yousoft-IT"><script>alert(1)</script></head><body><h1>Hi&amp;bye</h1></body>');
    expect(t).toContain('Founder of Yousoft-IT');
    expect(t).toContain('Hi&bye');
    expect(t).not.toContain('alert');
  });
});

describe('send_whatsapp (to the owner only)', () => {
  const ctxFor = async (whatsappOwner?: (t: string) => Promise<void>) => {
    const { iperson } = await makeIperson(db);
    return { db, llm: new FakeLlm([]), ipersonId: iperson.id, userName: 'Merry', timezone: 'Africa/Tunis', now: new Date(), whatsappOwner };
  };

  it('sends to the owner, and explains when WhatsApp isn’t linked or Meta blocks sending', async () => {
    const sent: string[] = [];
    expect(await sendWhatsapp.execute(await ctxFor(async (t) => { sent.push(t); }), { text: 'News: …' })).toEqual({ sent: true });
    expect(sent).toEqual(['News: …']);
    await reset(db);
    expect(await sendWhatsapp.execute(await ctxFor(), { text: 'x' })).toMatchObject({ sent: false, error: expect.stringMatching(/not linked/) });
    await reset(db);
    const blocked = await sendWhatsapp.execute(await ctxFor(async () => { throw new Error('WhatsApp send failed: HTTP 400 {"code":131037}'); }), { text: 'x' });
    expect(blocked).toMatchObject({ sent: false, error: expect.stringMatching(/display name/) });
  });

  it('falls back to the approved template outside the 24-hour window', async () => {
    const calls: string[] = [];
    const wa = {
      sendText: async () => { calls.push('text'); throw new Error('HTTP 400 {"code":131047}'); },
      sendTemplate: async (_to: string, name: string, _l: string, p: string[]) => { calls.push(`template:${name}:${p[0]}`); },
      sendButtons: async () => {}, sendImage: async () => {}, downloadMedia: async () => Buffer.alloc(0),
    };
    await sendToOwner(wa, '+49', 'Top news:\n1. A\n2. B', { name: 'iperson_update', lang: 'en' });
    expect(calls).toEqual(['text', 'template:iperson_update:Top news: · 1. A · 2. B']);
  });

  it('sends a picture with the text as caption, or before a long text', async () => {
    const calls: string[] = [];
    const wa = {
      sendText: async (_to: string, t: string) => { calls.push(`text:${t.length}`); },
      sendTemplate: async () => {}, sendButtons: async () => {}, downloadMedia: async () => Buffer.alloc(0),
      sendImage: async (_to: string, _b: Buffer, mime: string, caption: string) => { calls.push(`image:${mime}:${caption.length}`); },
    };
    const image = { data: Buffer.from([0xff, 0xd8]), mime: 'image/jpeg' };
    await sendToOwner(wa, '+49', 'Trip to Rome', { name: 't', lang: 'en' }, image);
    await sendToOwner(wa, '+49', 'x'.repeat(2000), { name: 't', lang: 'en' }, image);
    expect(calls).toEqual(['image:image/jpeg:12', 'image:image/jpeg:0', 'text:2000']);
  });

  it("finds a page's preview picture", () => {
    expect(previewImage('<meta property="og:image" content="/img/rome.jpg?a=1&amp;b=2">', 'https://deals.example/trip/1'))
      .toBe('https://deals.example/img/rome.jpg?a=1&b=2');
    expect(previewImage('<meta content="https://cdn.example/x.png" name="twitter:image">', 'https://a.example/')).toBe('https://cdn.example/x.png');
    expect(previewImage('<p>no picture</p>', 'https://a.example/')).toBeUndefined();
  });
});

describe('home-screen app icon', () => {
  it('is the twin\'s face for the signed-in user, the generic icon otherwise', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/me/manifest.webmanifest' });
    expect(anon.headers['content-type']).toContain('application/manifest+json');
    expect(anon.json()).toMatchObject({ start_url: '/talk', display: 'standalone', icons: [{ src: '/icon-192.png' }, { src: '/icon-512.png' }, { purpose: 'maskable' }] });
    expect((await app.inject({ method: 'GET', url: '/api/me/app-icon-180.png' })).headers.location).toBe('/icon-180.png');

    const { cookie, ipersonId } = await signUp();
    const file = `${ipersonId}-avatar-test.jpg`;
    mkdirSync(config.UPLOAD_DIR, { recursive: true });
    // A landscape picture: the icon must come out square.
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=300x200', '-frames:v', '1', join(config.UPLOAD_DIR, file)]);
    try {
      await db.update(ipersons).set({ avatarUrl: `/api/media/${file}` }).where(eq(ipersons.id, ipersonId));
      const m = (await app.inject({ method: 'GET', url: '/api/me/manifest.webmanifest', headers: { cookie } })).json();
      expect(m.icons[0].src).toMatch(/^\/api\/me\/app-icon-192\.png\?v=[0-9a-f]{10}$/);
      const icon = await app.inject({ method: 'GET', url: '/api/me/app-icon-192.png', headers: { cookie } });
      expect(icon.headers['content-type']).toBe('image/png');
      const png = icon.rawPayload;
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([192, 192]);
      expect((await app.inject({ method: 'GET', url: '/api/me/app-icon-64.png', headers: { cookie } })).statusCode).toBe(404);
    } finally {
      rmSync(join(config.UPLOAD_DIR, file), { force: true });
    }
  });
});
