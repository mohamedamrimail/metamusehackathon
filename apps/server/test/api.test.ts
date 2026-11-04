import type { ServerEvent } from '@ipersons/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { eq } from 'drizzle-orm';
import { buildApp, createDeps } from '../src/index.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import type { AvatarMaker } from '../src/meta/image.ts';
import { CONSENT_VERSION } from '@ipersons/shared';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config.ts';
import { actions, aiUsage, avatarAssets, ipersons, users } from '../src/db/schema.ts';
import { reset, testDb, testGeo } from './helpers.ts';

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

async function signUp(email = 'merry@example.com') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name: 'Merry' } });
  expect(res.statusCode).toBe(200);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const ip = await app.inject({ method: 'POST', url: '/api/ipersons', headers: { cookie }, payload: { display_name: 'Mimi', locale: 'en', timezone: 'Africa/Tunis' } });
  expect(ip.statusCode).toBe(201);
  return { cookie, ipersonId: ip.json().iperson.id as string };
}

describe('auth', () => {
  it('registers, logs in, and rejects bad passwords', async () => {
    await signUp();
    const ok = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'MERRY@example.com', password: 'correct horse' } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'merry@example.com', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    const dup = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'merry@example.com', password: 'correct horse', name: 'M' } });
    expect(dup.statusCode).toBe(409);
  });

  it('deletes the account and everything in it', async () => {
    const { cookie, ipersonId } = await signUp();
    await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/facts`, headers: { cookie }, payload: [{ category: 'goal', key: 'x', value: 'y' }] });
    expect((await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie }, payload: { password: 'nope' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie }, payload: { password: 'correct horse' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    const left = await pool.query('select (select count(*) from ipersons) + (select count(*) from profile_facts) + (select count(*) from wallets) as n');
    expect(Number(left.rows[0].n)).toBe(0);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'merry@example.com', password: 'correct horse' } });
    expect(login.statusCode).toBe(401);
  });

  it('requires a session', async () => {
    expect((await app.inject('/api/me')).statusCode).toBe(401);
  });

  it("keeps each user out of another's i-person", async () => {
    const merry = await signUp();
    const eve = await signUp('eve@example.com');
    for (const url of [`/ipersons/${merry.ipersonId}/facts`, `/ipersons/${merry.ipersonId}/actions`, `/ipersons/${merry.ipersonId}/wallet`]) {
      expect((await app.inject({ url, headers: { cookie: eve.cookie } })).statusCode).toBe(404);
    }
    expect((await app.inject({ url: `/media/${merry.ipersonId}-selfie-ab.jpg`, headers: { cookie: eve.cookie } })).statusCode).toBe(404);
  });
});

describe('avatar', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const upload = (cookie: string, ipersonId: string, source = 'camera') => {
    const boundary = 'xx';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\n${source}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="me.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      JPEG, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/selfie`, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  };
  const withAvatar = async (avatar: Omit<AvatarMaker, 'analyze' | 'generate'> & Partial<Pick<AvatarMaker, 'analyze' | 'generate'>>) => {
    await app.close();
    app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: false, avatar: { analyze: async () => ({ samCalls: 0 }), generate: async () => Buffer.from('scene'), ...avatar } }));
  };

  it('offers stylized versions first, the photo last, each with its mouth', async () => {
    await withAvatar({
      stylize: async () => [Buffer.from('style-1'), Buffer.from('style-2')],
      edit: async () => Buffer.from('edited'),
      findMouth: async (img) => ({ x: 0.5, y: img.equals(JPEG) ? 0.7 : 0.66, w: 0.2 }),
    });
    const { cookie, ipersonId } = await signUp();
    const r = await upload(cookie, ipersonId);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { options: string[]; mouths: unknown[]; selfie_url: string; generated: boolean };
    expect(body.generated).toBe(true);
    expect(body.options).toHaveLength(3);
    expect(body.options.at(-1)).toBe(body.selfie_url);
    expect(body.mouths).toEqual([{ x: 0.5, y: 0.66, w: 0.2 }, { x: 0.5, y: 0.66, w: 0.2 }, { x: 0.5, y: 0.7, w: 0.2 }]);
    const img = await app.inject({ url: body.options[0]!, headers: { cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.body).toBe('style-1');
  });

  it('restyles the original selfie or edits the current look, then saves the pick', async () => {
    const seen: { input: string; prompt: string }[] = [];
    await withAvatar({
      stylize: async () => [Buffer.from('style-1')],
      edit: async (img, _mime, prompt) => { seen.push({ input: img.toString('latin1'), prompt }); return Buffer.from(`edit-${seen.length}`); },
      findMouth: async () => ({ x: 0.5, y: 0.68, w: 0.18 }),
    });
    const { cookie, ipersonId } = await signUp();
    const customize = (payload: object) => app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/customize`, headers: { cookie }, payload });

    expect((await customize({ style: 'anime' })).statusCode).toBe(409); // no selfie yet
    const up = (await upload(cookie, ipersonId)).json() as { options: string[] };
    await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/select`, headers: { cookie }, payload: { url: up.options[0], this_is_me: true } });

    const anime = await customize({ style: 'anime' });
    expect(anime.json()).toMatchObject({ mouth: { x: 0.5, y: 0.68, w: 0.18 } });
    expect(seen[0]!.input).toBe(JPEG.toString('latin1')); // presets start from the photo
    expect(seen[0]!.prompt).toMatch(/anime/);

    const hat = await customize({ instruction: 'add a red wool hat' });
    expect(seen[1]!.input).toBe('style-1'); // words change the current avatar
    expect(seen[1]!.prompt).toMatch(/^add a red wool hat\. Keep the same person/);

    const url = (hat.json() as { url: string }).url;
    const sel = await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/select`, headers: { cookie }, payload: { url, mouth: { x: 0.5, y: 0.68, w: 0.18 }, this_is_me: true } });
    expect(sel.json().iperson).toMatchObject({ avatarUrl: url, avatarMeta: { selfie: expect.stringContaining('-selfie-'), mouth: { x: 0.5 } } });

    expect((await customize({ style: 'nope' })).statusCode).toBe(400);
    expect((await customize({ instruction: '' })).statusCode).toBe(400);
  });

  it('caps paid generations per day and explains blocked prompts', async () => {
    await withAvatar({
      stylize: async () => [],
      edit: async (_i, _m, prompt) => { if (/forbidden/.test(prompt)) throw new Error('400 content_policy_violation'); return Buffer.from('ok'); },
      findMouth: async () => null,
    });
    const { cookie, ipersonId } = await signUp();
    await upload(cookie, ipersonId); // 2 of the daily credits
    const customize = (instruction: string) => app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/customize`, headers: { cookie }, payload: { instruction } });
    await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/select`, headers: { cookie }, payload: { url: (await app.inject({ url: '/api/me', headers: { cookie } })).json().iperson.avatarMeta.selfie, this_is_me: true } });
    const blocked = await customize('something forbidden');
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toBe('blocked');
    for (let i = 0; i < 17; i++) expect((await customize('add glasses')).statusCode).toBe(200);
    expect((await customize('add glasses')).statusCode).toBe(429);
  });

  it('takes photo files only after WhatsApp is verified; camera selfies always', async () => {
    const { cookie, ipersonId } = await signUp();
    const file = await upload(cookie, ipersonId, 'file');
    expect(file.statusCode).toBe(403);
    expect(file.json().error).toBe('verify_whatsapp_first');
    expect((await upload(cookie, ipersonId, 'camera')).statusCode).toBe(200);
    await db.update(users).set({ phoneE164: '+21699111222' });
    expect((await upload(cookie, ipersonId, 'file')).statusCode).toBe(200);
  });

  it('offers neutral library avatars matching the profile, and uses one', async () => {
    const lib = (gender: 'woman' | 'man', ageRange: '25-34' | '35-44', n: number) => db.insert(avatarAssets).values(
      Array.from({ length: n }, (_, i) => ({ library: true, style: 'animated', gender, ageRange, imageUrl: `/api/media/library-${gender}${ageRange}${i}.jpg`, masks: { mouth: { x: 0.5, y: 0.45, w: 0.1 } } })),
    );
    await lib('woman', '25-34', 5);
    await lib('man', '35-44', 2);
    const { cookie, ipersonId } = await signUp();
    const r = (await app.inject({ url: '/api/avatar/library?gender=woman&age_range=25-34', headers: { cookie } })).json() as { matching: { id: string; url: string }[]; others: unknown[] };
    expect(r.matching).toHaveLength(4);
    expect(r.others).toHaveLength(3);
    const pick = await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/neutral`, headers: { cookie }, payload: { asset_id: r.matching[0]!.id } });
    expect(pick.json().iperson).toMatchObject({ avatarUrl: r.matching[0]!.url, avatarAssetId: r.matching[0]!.id, avatarMeta: { mouth: { y: 0.45 } } });
    // Library images are shared with every signed-in user (unlike personal photos).
    await writeFile(join(config.UPLOAD_DIR, 'library-test.jpg'), 'img');
    expect((await app.inject({ url: '/api/media/library-test.jpg', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/media/library-test.jpg' })).statusCode).toBe(401);
    await rm(join(config.UPLOAD_DIR, 'library-test.jpg'));
  });

  it('brings the twin to life: pose set, masks and cut-outs, with a missing pose tolerated', async () => {
    await withAvatar({
      stylize: async () => [Buffer.from('style-1')],
      edit: async (_img, _mime, prompt) => { if (/thumbs up/.test(prompt)) throw new Error('drifted'); return Buffer.from('pose'); },
      findMouth: async () => ({ x: 0.5, y: 0.45, w: 0.1 }),
      analyze: async () => ({ samCalls: 4, person: { x1: 0.1, y1: 0, x2: 0.9, y2: 1 }, eyes: { x1: 0.4, y1: 0.3, x2: 0.6, y2: 0.34 }, mouth: { x: 0.5, y: 0.45, w: 0.1, box: { x1: 0.45, y1: 0.44, x2: 0.55, y2: 0.47 } }, cutout: Buffer.from('png') }),
    });
    const { cookie, ipersonId } = await signUp();
    const up = (await upload(cookie, ipersonId)).json() as { options: string[] };
    await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/select`, headers: { cookie }, payload: { url: up.options[0], this_is_me: true } });

    const before = (await app.inject({ url: `/api/ipersons/${ipersonId}/avatar/life`, headers: { cookie } })).json();
    expect(before).toMatchObject({ images: 7, sam_calls: 32, cost_usd: 0.3, rig: { alive: false, variants: { base: { url: up.options[0] } } } });

    const life = await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/life`, headers: { cookie } });
    expect(life.statusCode).toBe(200);
    const { rig, missing } = life.json() as { rig: { alive: boolean; variants: Record<string, { url: string; cutout_url?: string; masks: { eyes?: unknown } }> }; missing: number };
    expect(missing).toBe(1);
    expect(Object.keys(rig.variants).sort()).toEqual(['base', 'blink', 'listening', 'smile', 'surprised', 'thinking', 'wave']);
    expect(rig.alive).toBe(true);
    expect(rig.variants.base!.url).toBe(up.options[0]);
    expect(rig.variants.smile!.masks.eyes).toBeDefined();
    expect((await app.inject({ url: rig.variants.smile!.cutout_url!, headers: { cookie } })).body).toBe('png');

    // Changing the avatar retires the old poses: the rig falls back to the plain image.
    const other = (await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/customize`, headers: { cookie }, payload: { instruction: 'add a hat' } })).json() as { url: string };
    await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/select`, headers: { cookie }, payload: { url: other.url, this_is_me: true } });
    const after = (await app.inject({ url: `/api/ipersons/${ipersonId}/avatar/life`, headers: { cookie } })).json();
    expect(Object.keys(after.rig.variants)).toEqual(['base']);
  });

  it('sets scenes: cached Pexels presets, plain studio, generated custom, and keeps them on avatar change', async () => {
    await withAvatar({ stylize: async () => [], edit: async () => Buffer.from('x'), findMouth: async () => null });
    const { cookie, ipersonId } = await signUp();
    await mkdir(config.UPLOAD_DIR, { recursive: true });
    await writeFile(join(config.UPLOAD_DIR, 'scene-office.json'), JSON.stringify({ id: 'office', url: '/api/media/scene-office.jpg', credit: 'Ann / Pexels' }));
    const scene = (payload: object) => app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/scene`, headers: { cookie }, payload });

    expect((await scene({ preset: 'office' })).json().scene).toMatchObject({ id: 'office', credit: 'Ann / Pexels' });
    expect((await scene({ preset: 'studio' })).json().scene).toEqual({ id: 'studio', url: null });
    expect((await scene({ preset: 'beach' })).statusCode).toBe(502); // no Pexels key in tests, nothing cached
    const custom = (await scene({ prompt: 'a quiet library with tall shelves' })).json();
    expect(custom.scene.url).toMatch(new RegExp(`^/api/media/${ipersonId}-scene-`));
    expect((await scene({ smart: true })).json().iperson.avatarMeta).toMatchObject({ smartScenes: true, scene: { id: 'custom' } });

    const up = (await upload(cookie, ipersonId)).json() as { options: string[] };
    const sel = await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/select`, headers: { cookie }, payload: { url: up.options[0], this_is_me: true } });
    expect(sel.json().iperson.avatarMeta.scene).toMatchObject({ id: 'custom' });
    await rm(join(config.UPLOAD_DIR, 'scene-office.json'));
  });

  it('is off without the Meta key', async () => {
    const { cookie, ipersonId } = await signUp();
    const r = await app.inject({ method: 'POST', url: `/api/ipersons/${ipersonId}/avatar/customize`, headers: { cookie }, payload: { style: 'anime' } });
    expect(r.statusCode).toBe(503);
    expect((await app.inject({ url: '/api/avatar/styles', headers: { cookie } })).json()).toMatchObject({ enabled: false, styles: expect.arrayContaining([{ id: 'anime', label: 'Anime' }]) });
  });

  it('falls back to the photo when Muse Image or SAM fail', async () => {
    await withAvatar({
      stylize: async () => { throw new Error('content_policy_violation'); },
      edit: async () => { throw new Error('content_policy_violation'); },
      findMouth: async () => { throw new Error('timeout'); },
    });
    const { cookie, ipersonId } = await signUp();
    const body = (await upload(cookie, ipersonId)).json() as { options: string[]; mouths: unknown[]; generated: boolean };
    expect(body).toMatchObject({ generated: false, mouths: [null] });
    expect(body.options).toHaveLength(1);
  });
});

describe('profile and consent', () => {
  it('asks new users to consent, records it, and asks again when the text changes', async () => {
    const { cookie } = await signUp();
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).json().user.consent_required).toBe(true);
    const r = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: { cookie }, payload: { gender: 'woman', age_range: '35-44', consent_version: CONSENT_VERSION } });
    expect(r.json().user).toMatchObject({ gender: 'woman', age_range: '35-44', consent_required: false });
    const [u] = await db.select().from(users);
    expect(u!.consentAt).toBeInstanceOf(Date);
    await db.update(users).set({ consentVersion: CONSENT_VERSION - 1 });
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).json().user.consent_required).toBe(true);
  });

  it('has no under-18 option and rejects an outdated consent version', async () => {
    const { cookie } = await signUp();
    expect((await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: { cookie }, payload: { age_range: '13-17' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: { cookie }, payload: { consent_version: 0 } })).statusCode).toBe(400);
  });
});

describe('facts', () => {
  it('creates in bulk, edits and deletes', async () => {
    const { cookie, ipersonId } = await signUp();
    const created = await app.inject({
      method: 'POST', url: `/ipersons/${ipersonId}/facts`, headers: { cookie },
      payload: [{ category: 'routine', key: 'yoga', value: 'Tuesdays' }, { category: 'goal', key: 'month', value: 'Run 5k' }],
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().facts[0].id;
    const edited = await app.inject({ method: 'PATCH', url: `/ipersons/${ipersonId}/facts/${id}`, headers: { cookie }, payload: { value: 'Tue & Thu' } });
    expect(edited.json().fact).toMatchObject({ value: 'Tue & Thu', source: 'user_edit' });
    expect((await app.inject({ method: 'DELETE', url: `/ipersons/${ipersonId}/facts/${id}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: `/ipersons/${ipersonId}/facts`, headers: { cookie } })).json().facts).toHaveLength(1);
  });
});

function connect(cookie: string, ipersonId: string): Promise<{ ws: WebSocket; events: ServerEvent[]; next: (type: string) => Promise<ServerEvent> }> {
  const port = (app.server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/session?iperson=${ipersonId}`, { headers: { cookie } });
  const events: ServerEvent[] = [];
  const used = new Set<number>();
  const waiters: { type: string; resolve: (e: ServerEvent) => void }[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // speech audio
    const e = JSON.parse(String(data)) as ServerEvent;
    events.push(e);
    const w = waiters.findIndex((x) => x.type === e.type);
    if (w >= 0) {
      used.add(events.length - 1);
      waiters.splice(w, 1)[0]!.resolve(e);
    }
  });
  // The next event of `type` not handed out yet, in arrival order.
  const next = (type: string) => new Promise<ServerEvent>((resolve) => {
    const idx = events.findIndex((e, i) => !used.has(i) && e.type === type);
    if (idx >= 0) {
      used.add(idx);
      return resolve(events[idx]!);
    }
    waiters.push({ type, resolve });
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, events, next }));
    ws.on('error', reject);
  });
}

describe('voice session (demo model)', () => {
  it('proposes, confirms over REST, and speaks the result', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { cookie, ipersonId } = await signUp();
    const s = await connect(cookie, ipersonId);
    expect(await s.next('session.ready')).toMatchObject({ stt: 'browser', demo: true });

    s.ws.send(JSON.stringify({ type: 'text.input', text: 'Book yoga on Tuesday 6pm' }));
    const proposed = await s.next('action.proposed');
    expect(proposed).toMatchObject({ tool: 'calendar_book', risk: 'write' });
    expect((await s.next('agent.text') as { text: string }).text).toContain('Shall I');

    const actionId = (proposed as { action_id: string }).action_id;
    const list = await app.inject({ url: `/ipersons/${ipersonId}/actions`, headers: { cookie } });
    expect(list.json().actions[0]).not.toHaveProperty('confirmToken');

    const ok = await app.inject({ method: 'POST', url: `/actions/${actionId}/confirm`, headers: { cookie } });
    expect(ok.json().action.status).toBe('done');
    expect(await s.next('action.updated')).toMatchObject({ action_id: actionId, status: 'done' });
    expect((await s.next('agent.text') as { text: string }).text).toMatch(/^Done: Book/);

    const again = await app.inject({ method: 'POST', url: `/actions/${actionId}/confirm`, headers: { cookie } });
    expect(again.statusCode).toBe(409);
    s.ws.close();
  });

  it('shows cards still waiting for a yes when Talk is opened again', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { cookie, ipersonId } = await signUp();
    await db.insert(actions).values([
      { ipersonId, tool: 'calendar_book', risk: 'write', args: {}, summary: 'Book "Table tennis"', confirmToken: 'tok-live', expiresAt: new Date(Date.now() + 3_600_000) },
      { ipersonId, tool: 'calendar_book', risk: 'write', args: {}, summary: 'Old', confirmToken: 'tok-old', expiresAt: new Date(Date.now() - 1000) },
    ]);
    const s = await connect(cookie, ipersonId);
    expect(await s.next('action.proposed')).toMatchObject({ summary: 'Book "Table tennis"', tool: 'calendar_book' });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.events.filter((e) => e.type === 'action.proposed')).toHaveLength(1);
    s.ws.close();
  });

  it('the judge demo account is public without a phone; others need one', async () => {
    const { ipersonId } = await signUp();
    await db.update(ipersons).set({ handle: 'demo', publicEnabled: true }).where(eq(ipersons.id, ipersonId));
    expect((await app.inject({ url: '/api/public/demo' })).statusCode).toBe(404);
    await db.update(users).set({ accountKind: 'demo' });
    expect((await app.inject({ url: '/api/public/demo' })).statusCode).toBe(200);
  });

  it('a spoken "yes" confirms through the socket', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { cookie, ipersonId } = await signUp();
    await db.update(users).set({ phoneE164: '+21699000222', verifiedAt: new Date() }); // email needs a verified sender
    const s = await connect(cookie, ipersonId);
    s.ws.send(JSON.stringify({ type: 'text.input', text: 'send the party invites' }));
    await s.next('action.proposed');
    s.ws.send(JSON.stringify({ type: 'text.input', text: 'yes' }));
    expect(await s.next('action.updated')).toMatchObject({ status: 'done' });
    s.ws.close();
  });

  describe('browser voice', () => {
    it('asks the browser to speak each final reply, without web addresses', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { cookie, ipersonId } = await signUp();
      const s = await connect(cookie, ipersonId);
      s.ws.send(JSON.stringify({ type: 'text.input', text: 'Book yoga on Tuesday 6pm' }));
      const reply = await s.next('agent.text') as { text: string };
      const spoken = await s.next('speak') as { text: string };
      expect(spoken.text.length).toBeGreaterThan(0);
      expect(spoken.text).not.toMatch(/https?:\/\//);
      expect(reply.text.length).toBeGreaterThan(0);
      s.ws.close();
    });

    it('speaks on one screen only: the one used last', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { cookie, ipersonId } = await signUp();
      const phone = await connect(cookie, ipersonId);
      const laptop = await connect(cookie, ipersonId);
      await phone.next('session.ready');
      await laptop.next('session.ready');
      phone.ws.send(JSON.stringify({ type: 'text.input', text: 'hello' }));
      await phone.next('speak');
      // Both see the reply; only the phone (used last) is asked to speak.
      await laptop.next('agent.text');
      await new Promise((r) => setTimeout(r, 100));
      expect(laptop.events.some((e) => e.type === 'speak')).toBe(false);
      phone.ws.close();
      laptop.ws.close();
    });

    it('a tap on the avatar says a short line', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { cookie, ipersonId } = await signUp();
      const s = await connect(cookie, ipersonId);
      await s.next('session.ready');
      s.ws.send(JSON.stringify({ type: 'avatar.tap' }));
      expect(((await s.next('speak')) as { text: string }).text.length).toBeGreaterThan(0);
      s.ws.close();
    });
  });

  it('refuses a socket without a session', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { ipersonId } = await signUp();
    const s = await connect('', ipersonId);
    expect(await s.next('error')).toMatchObject({ code: 'not_signed_in' });
  });
});
