import { afterAll, expect, it } from 'vitest';
import { buildApp, createDeps } from '../src/index.ts';
import { testDb, testGeo } from './helpers.ts';

const { db, pool } = testDb();
afterAll(() => pool.end());

it('GET /health checks the database', async () => {
  const app = buildApp(createDeps(db, { geo: testGeo }));
  const res = await app.inject('/health');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ ok: true });
  await app.close();
});
