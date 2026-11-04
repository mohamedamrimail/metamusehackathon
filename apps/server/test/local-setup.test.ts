import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.ts';
import { clearCountryCache } from '../src/geo/countries.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import { checkMetaKey, keyBanner } from '../src/meta/key-check.ts';
import { geoFor, reset, testDb, testGeo } from './helpers.ts';

// Running from a fresh clone: the Meta key check, GET /features and the country allowlist switch.

const { db, pool } = testDb();
let app: FastifyInstance;
const saved = { key: config.META_API_KEY, allowlist: config.ALLOWLIST_ENABLED, env: config.NODE_ENV };

beforeEach(async () => {
  await reset(db);
  await db.execute('truncate settings');
  clearCountryCache();
  await app?.close();
  app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true }));
});
afterEach(() => {
  config.META_API_KEY = saved.key;
  config.ALLOWLIST_ENABLED = saved.allowlist;
  config.NODE_ENV = saved.env;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const fakeFetch = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('Meta key check at startup', () => {
  it('reports a missing key without calling the API', async () => {
    config.META_API_KEY = undefined;
    let called = false;
    const r = await checkMetaKey((async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch);
    expect(r.status).toBe('missing');
    expect(called).toBe(false);
    expect(keyBanner(r)).toContain('DEMO MODE');
  });

  it('reports a rejected key', async () => {
    config.META_API_KEY = 'bad-key';
    const r = await checkMetaKey(fakeFetch(401));
    expect(r.status).toBe('invalid');
    expect(r.message).toMatch(/rejected/);
  });

  it('accepts a working key and lists missing models', async () => {
    config.META_API_KEY = 'good-key';
    const ok = await checkMetaKey(fakeFetch(200, { data: [{ id: config.META_LLM_MODEL }, { id: config.META_SAM_MODEL }] }));
    expect(ok).toMatchObject({ status: 'ok' });
    expect(ok.message).toMatch(/available/);
    const partial = await checkMetaKey(fakeFetch(200, { data: [{ id: config.META_LLM_MODEL }] }));
    expect(partial.message).toContain(config.META_SAM_MODEL);
  });

  it('carries on when the API cannot be reached', async () => {
    config.META_API_KEY = 'good-key';
    const r = await checkMetaKey((async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch);
    expect(r.status).toBe('unreachable');
  });
});

describe('GET /features', () => {
  it('says which optional integrations are configured, without secrets', async () => {
    config.META_API_KEY = undefined;
    await checkMetaKey();
    const f = (await app.inject({ url: '/api/features' })).json();
    expect(f).toMatchObject({ meta: { status: 'missing' }, demo: true, whatsapp: false, glasses: true, email: false, scenes: false, google: false });
    expect(JSON.stringify(f)).not.toMatch(/test-encryption-key|test-ms-secret/);
  });
});

describe('country allowlist switch', () => {
  it('allows every country when ALLOWLIST_ENABLED=false or NODE_ENV=development', async () => {
    const register = (email: string) => app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name: 'X' } });
    geoFor.country = 'FR';
    expect((await register('fr1@example.com')).statusCode).toBe(403);
    config.ALLOWLIST_ENABLED = 'false';
    expect((await register('fr2@example.com')).statusCode).toBe(200);
    config.ALLOWLIST_ENABLED = 'true';
    config.NODE_ENV = 'development';
    geoFor.country = null;
    expect((await register('unknown@example.com')).statusCode).toBe(200);
  });
});
