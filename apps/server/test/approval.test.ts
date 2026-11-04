import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminLog, inviteCodes, settings, users } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { approvalLink } from '../src/lib/approval.ts';
import { clearRuntimeCache } from '../src/lib/settings.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { reset, testDb, testGeo } from './helpers.ts';

// Beta: new accounts wait for approval; existing accounts, judges and admins don't.

const { db, pool } = testDb();
let app: FastifyInstance;
beforeEach(async () => {
  await reset(db);
  await db.execute('truncate settings, invite_codes, admin_log');
  await db.insert(settings).values({ key: 'runtime', value: { requireApproval: true } });
  clearRuntimeCache();
  await app?.close();
  app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true }));
});
afterAll(async () => {
  await db.execute('truncate settings');
  clearRuntimeCache();
  await app.close();
  await pool.end();
});

const register = (email: string, extra: object = {}) =>
  app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name: 'Nour', ...extra } });
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0]!;

describe('beta approval', () => {
  it('holds a new account until it is approved, then lets it in', async () => {
    const r = await register('new@example.com');
    expect(r.statusCode).toBe(200);
    expect(r.json().user.pending_approval).toBe(true);
    const cookie = cookieOf(r);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).json().user.pending_approval).toBe(true);
    const blocked = await app.inject({ method: 'PATCH', url: '/api/me/setup', headers: { cookie }, payload: { step: 'about_you' } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('pending_approval');

    const admin = cookieOf(await register('admin@example.com'));
    const list = (await app.inject({ url: '/api/admin/users?pending=1', headers: { cookie: admin } })).json().users;
    expect(list.map((u: { email: string }) => u.email)).toEqual(['new@example.com']);
    const [u] = await db.select().from(users).where(eq(users.email, 'new@example.com'));
    expect((await app.inject({ method: 'POST', url: `/api/admin/users/${u!.id}/approve`, headers: { cookie: admin } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/api/me/setup', headers: { cookie }, payload: { step: 'about_you' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).json().user.pending_approval).toBe(false);
  });

  it('never holds judges, admins or accounts made before the gate', async () => {
    await db.insert(inviteCodes).values({ code: 'JUDGES-T1', kind: 'judge', maxUses: 100 });
    expect((await register('judge@example.com', { invite_code: 'JUDGES-T1' })).json().user.pending_approval).toBe(false);
    expect((await register('admin@example.com')).json().user.pending_approval).toBe(false);
    const [old] = await db.insert(users).values({ email: 'old@example.com', name: 'Old', passwordHash: null }).returning();
    expect(old!.pendingApprovalAt).toBeNull();
  });

  it('approves from the email link only with a valid signature, and only on POST', async () => {
    await register('new@example.com');
    const [u] = await db.select().from(users).where(eq(users.email, 'new@example.com'));
    const path = new URL(approvalLink(u!.id)).pathname + new URL(approvalLink(u!.id)).search;
    const sig = new URL(approvalLink(u!.id)).searchParams.get('sig')!;
    const page = await app.inject({ url: path });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Approve this account?');
    expect((await db.select().from(users).where(eq(users.id, u!.id)))[0]!.pendingApprovalAt).not.toBeNull(); // GET changes nothing
    const bad = await app.inject({ method: 'POST', url: `/api/approve/${u!.id}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'sig=nope' });
    expect(bad.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/api/approve/${u!.id}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `sig=${sig}` });
    expect(ok.body).toContain('Approved');
    expect((await db.select().from(users).where(eq(users.id, u!.id)))[0]!.pendingApprovalAt).toBeNull();
    expect((await db.select().from(adminLog)).map((l) => l.action)).toContain('user.approve');
  });

  it('is off when the admin setting says so', async () => {
    await db.update(settings).set({ value: { requireApproval: false } }).where(eq(settings.key, 'runtime'));
    clearRuntimeCache();
    expect((await register('free@example.com')).json().user.pending_approval).toBe(false);
  });
});
