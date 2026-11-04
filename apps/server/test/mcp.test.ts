import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentRuntime } from '../src/agent/runtime.ts';
import { assertPublicUrl, McpRegistry } from '../src/mcp/client.ts';
import { config } from '../src/config.ts';
import { connections } from '../src/db/schema.ts';
import { call, FakeLlm, makeIperson, reset, say, testDb } from './helpers.ts';

const { db, pool } = testDb();
let registry: McpRegistry;
const calls: string[] = [];

beforeEach(async () => {
  await reset(db);
  calls.length = 0;
  registry = new McpRegistry(db, () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'groceries', version: '1.0.0' });
    server.registerTool('add_to_list', { description: 'Add an item to the shopping list', inputSchema: { item: z.string() } }, async ({ item }) => {
      calls.push(item);
      return { content: [{ type: 'text', text: `added ${item}` }] };
    });
    void server.connect(serverSide);
    return clientSide;
  });
});
afterAll(async () => { await registry.close(); await pool.end(); });

it('exposes MCP tools as write tools that need confirmation', async () => {
  const { iperson } = await makeIperson(db);
  await db.insert(connections).values({ ipersonId: iperson.id, kind: 'mcp', config: { url: 'http://mcp.example.com/mcp', name: 'Groceries' } });

  const tools = await registry.toolsFor(iperson.id);
  expect(tools.map((t) => [t.name, t.risk])).toEqual([['mcp_groceries_add_to_list', 'write']]);

  const llm = new FakeLlm([call('mcp_groceries_add_to_list', { item: 'milk' }), say('Add milk?'), say('Added.')]);
  const rt = new AgentRuntime({ db, llm, extraTools: (id) => registry.toolsFor(id) });
  const conversationId = await rt.conversationFor(iperson.id, 'web');
  const res = await rt.handleUserMessage({ ipersonId: iperson.id, conversationId, text: 'add milk to my list' });

  expect(llm.calls[0]!.tools.some((t) => t.name === 'mcp_groceries_add_to_list')).toBe(true);
  expect(res.proposed).toHaveLength(1);
  expect(calls).toEqual([]); // nothing ran yet

  const { action } = await rt.decide({ ipersonId: iperson.id, actionId: res.proposed[0]!.id, approve: true });
  expect(action).toMatchObject({ status: 'done', result: { text: 'added milk' } });
  expect(calls).toEqual(['milk']);
});

it('refuses internal addresses in production', async () => {
  const env = config.NODE_ENV;
  config.NODE_ENV = 'production';
  try {
    await expect(assertPublicUrl('http://example.com/mcp')).rejects.toThrow(/https/);
    await expect(assertPublicUrl('https://127.0.0.1/mcp')).rejects.toThrow(/not public/);
    await expect(assertPublicUrl('https://10.0.0.5/mcp')).rejects.toThrow(/not public/);
  } finally {
    config.NODE_ENV = env;
  }
});

it('admin MCP connectors: tested on save, auth never returned, tools only for users who enable them', async () => {
  const { buildApp, createDeps } = await import('../src/index.ts');
  const { testGeo } = await import('./helpers.ts');
  const { DemoLlm } = await import('../src/meta/demo-llm.ts');
  const { users, connectors: connectorsTable } = await import('../src/db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true, mcp: registry }));
  try {
    const reg = async (email: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name: 'X' } });
      const cookie = String(r.headers['set-cookie']).split(';')[0]!;
      await db.update(users).set({ phoneE164: `+2165000${Math.floor(Math.random() * 9000 + 1000)}` }).where(eq(users.email, email));
      const ip = (await app.inject({ method: 'POST', url: '/api/ipersons', headers: { cookie }, payload: { display_name: 'X' } })).json().iperson;
      return { cookie, ipersonId: ip.id as string };
    };
    const admin = await reg('admin@example.com');
    const put = await app.inject({ method: 'PUT', url: '/api/admin/connectors', headers: { cookie: admin.cookie }, payload: { slug: 'groceries', name: 'Groceries', type: 'mcp', category: 'shopping', tagline: 'Your shopping list', mcp_url: 'https://mcp.example.com/mcp', mcp_auth: 'Bearer s3cret', scopes: [{ id: 'use', label: 'Use my list', description: 'Add items', required: true }] } });
    expect(put.json()).toMatchObject({ tools: ['add_to_list'], connector: { mcpAuthSet: true } });
    expect(put.body).not.toContain('s3cret');
    const [row] = await db.select().from(connectorsTable).where(eq(connectorsTable.slug, 'groceries'));
    expect(row!.mcpAuthEnc).not.toContain('s3cret');
    expect((await app.inject({ method: 'POST', url: '/api/admin/connectors/groceries/test', headers: { cookie: admin.cookie } })).json()).toEqual({ ok: true, tools: ['add_to_list'] });

    const u = await reg('user@example.com');
    expect((await registry.toolsFor(u.ipersonId)).map((t) => t.name)).toEqual([]);
    await app.inject({ method: 'POST', url: '/api/store/groceries/activate', headers: { cookie: u.cookie } });
    const tools = await registry.toolsFor(u.ipersonId);
    expect(tools.map((t) => [t.name, t.risk, t.external])).toEqual([['mcp_groceries_add_to_list', 'write', 'mcp:Groceries']]);
  } finally {
    await db.delete((await import('../src/db/schema.ts')).connectors).where((await import('drizzle-orm')).eq((await import('../src/db/schema.ts')).connectors.slug, 'groceries'));
    await app.close();
  }
});
