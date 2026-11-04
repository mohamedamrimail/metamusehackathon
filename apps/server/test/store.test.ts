import type { ServerEvent } from '@ipersons/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { actions, users } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import type { AppDeps } from '../src/http/deps.ts';
import { FakeLlm, reset, say, testDb, testGeo } from './helpers.ts';

const { db, pool } = testDb();
let app: FastifyInstance;
let deps: AppDeps;
let llm: FakeLlm;

beforeEach(async () => {
  await reset(db);
  await app?.close();
  llm = new FakeLlm([], say('ok'));
  deps = createDeps(db, { geo: testGeo, llm, stt: undefined, demoMode: true });
  app = buildApp(deps);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function signUp(email = 'merry@example.com') {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name: 'Merry' } });
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  await db.update(users).set({ phoneE164: `+2165${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, phoneCountry: 'TN', verifiedAt: new Date() }).where(eq(users.email, email));
  const ip = await app.inject({ method: 'POST', url: '/api/ipersons', headers: { cookie }, payload: { display_name: 'Mimi', locale: 'en', timezone: 'Africa/Tunis' } });
  return { cookie, ipersonId: ip.json().iperson.id as string };
}

describe('Service Store', () => {
  it('lists the seeded services, activates with required + chosen scopes, logs it and cheers', async () => {
    const { cookie, ipersonId } = await signUp();
    const list = (await app.inject({ url: '/api/store', headers: { cookie } })).json();
    expect(list.services.map((s: { slug: string }) => s.slug)).toEqual(['yousoft', 'amazon-de', 'booking', 'skyscanner']);
    expect(list.services[0]).toMatchObject({ name: 'Yousoft IT', featured: true, verified: true, active: false, icon_url: null });

    const events: ServerEvent[] = [];
    deps.bus.subscribe(ipersonId, (e) => events.push(e));
    const r = await app.inject({ method: 'POST', url: '/api/store/yousoft/activate', headers: { cookie }, payload: { scopes: ['requests'] } });
    expect(r.json()).toMatchObject({ service: { active: true, granted_scopes: ['receive_offers', 'requests'] }, next_step: { kind: 'none' } });
    expect(events).toContainEqual({ type: 'service.activated', name: 'Yousoft IT', line: "Thanks! I'm now connected to Yousoft IT: jobs and internships that fit your skills." });
    const [log] = await db.select().from(actions);
    expect(log).toMatchObject({ tool: 'store_activate', status: 'done', summary: 'Activated Yousoft IT' });

    const amazon = (await app.inject({ method: 'POST', url: '/api/store/amazon-de/activate', headers: { cookie } })).json();
    expect(amazon).toMatchObject({ next_step: { kind: 'connect_mailbox' }, service: { health: 'needs_attention' } });

    const off = await app.inject({ method: 'POST', url: '/api/store/yousoft/deactivate', headers: { cookie } });
    expect(off.json().deleted).toContain('the permissions you granted');
    const after = (await app.inject({ url: '/api/store', headers: { cookie } })).json();
    expect(after.services.find((s: { slug: string }) => s.slug === 'yousoft').active).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/store/nope/activate', headers: { cookie } })).statusCode).toBe(404);
  });

  it("tells the agent what's active (to use) and what isn't (to suggest)", async () => {
    const { cookie, ipersonId } = await signUp();
    await app.inject({ method: 'POST', url: '/api/store/booking/activate', headers: { cookie } });
    const conversationId = await deps.runtime.conversationFor(ipersonId, 'web');
    await deps.runtime.handleUserMessage({ ipersonId, conversationId, text: 'where did I stay last time?' });
    const context = llm.calls[0]!.messages.at(-1)!.content as string;
    expect(context).toContain('Active services: Booking.com (Learn how you travel');
    expect(context).toMatch(/Not activated \(suggest only if useful\): Yousoft IT, Amazon\.de, Skyscanner/);
  });

  it('lets only admins edit the catalog; SVG icons are served without scripts', async () => {
    const user = await signUp();
    expect((await app.inject({ url: '/api/admin/connectors', headers: { cookie: user.cookie } })).statusCode).toBe(403);
    const admin = await signUp('admin@example.com');
    const boundary = 'b';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="9" height="9"/></svg>';
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="i.svg"\r\nContent-Type: image/svg+xml\r\n\r\n${svg}\r\n--${boundary}--\r\n`;
    const up = await app.inject({ method: 'POST', url: '/api/admin/connectors/booking/icon', headers: { cookie: admin.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    const icon = up.json().connector.iconUrl as string;
    const served = await app.inject({ url: icon, headers: { cookie: user.cookie } });
    expect(served.headers['content-security-policy']).toContain("default-src 'none'");
    expect(served.headers['content-type']).toContain('image/svg+xml');
    const put = await app.inject({ method: 'PUT', url: '/api/admin/connectors', headers: { cookie: admin.cookie }, payload: { slug: 'zalando', name: 'Zalando', type: 'mail', category: 'shopping', tagline: 'Your fashion orders', sender_domains: ['zalando.de'] } });
    expect(put.json().connector).toMatchObject({ slug: 'zalando', senderDomains: ['zalando.de'] });
    await db.execute("delete from connectors where slug = 'zalando'");
  });
});
