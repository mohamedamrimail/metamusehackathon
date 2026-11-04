import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { and, eq } from 'drizzle-orm';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Tool } from '../agent/tools/types.ts';
import { config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { connections, connectors, ipersons, userServices } from '../db/schema.ts';
import { decrypt } from '../lib/crypto.ts';

// MCP client: each server a user connects becomes a set of mcp_* tools for their i-person.
// SPEC default: every MCP tool is risk=write, so it always needs the user's yes.

export type TransportFactory = (url: string, headers?: Record<string, string>) => Transport;

const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^::1$/, /^f[cd]/i, /^fe80/i, /^::ffff:(127|10|192\.168)\./];

/** Users supply these URLs and the server connects to them: refuse internal addresses (SSRF). */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (config.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('MCP server must use https');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported protocol');
  if (config.NODE_ENV !== 'production') return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some((a) => PRIVATE.some((re) => re.test(a)))) throw new Error('MCP server address is not public');
  return url;
}

const defaultTransport: TransportFactory = (url, headers) => new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined);

interface Cached { client: Client; tools: Tool[]; at: number }

export class McpRegistry {
  private cache = new Map<string, Cached>();

  constructor(private db: Db, private transport: TransportFactory = defaultTransport, private ttlMs = 5 * 60_000) {}

  /**
   * mcp_* tools for an i-person: its own MCP connections plus admin MCP connectors the user activated in
   * the Store (Phase 4b/4c — the agent only sees tools of connectors the user enabled). Broken servers are skipped.
   */
  async toolsFor(ipersonId: string): Promise<Tool[]> {
    const [ip] = await this.db.select({ userId: ipersons.userId }).from(ipersons).where(eq(ipersons.id, ipersonId));
    const store = ip ? await this.db.select({ c: connectors }).from(userServices).innerJoin(connectors, eq(connectors.id, userServices.connectorId))
      .where(and(eq(userServices.userId, ip.userId), eq(connectors.type, 'mcp'), eq(connectors.live, true))) : [];
    const fromStore = await Promise.all(store.map(async ({ c }) => {
      if (!c.mcpUrl) return [];
      try {
        return await this.serverTools(c.mcpUrl, c.name, { headers: c.mcpAuthEnc ? authHeader(decrypt(c.mcpAuthEnc)) : undefined, allow: c.toolAllowlist as string[] });
      } catch {
        return [];
      }
    }));
    const rows = await this.db.select().from(connections)
      .where(and(eq(connections.ipersonId, ipersonId), eq(connections.kind, 'mcp'), eq(connections.enabled, 1)));
    const lists = await Promise.all(rows.map(async (row) => {
      const cfg = row.config as { url?: string; name?: string | null };
      if (!cfg.url) return [];
      try {
        return await this.serverTools(cfg.url, cfg.name ?? new URL(cfg.url).hostname);
      } catch {
        return [];
      }
    }));
    return [...fromStore.flat(), ...lists.flat()];
  }

  /** Admin "Test connection": connects, lists the server's tools (no cache). */
  async test(url: string, auth?: string): Promise<string[]> {
    await assertPublicUrl(url);
    const client = new Client({ name: 'i-persons', version: '0.1.0' });
    await client.connect(this.transport(url, auth ? authHeader(auth) : undefined));
    try {
      return (await client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.cache.values()].map((c) => c.client.close().catch(() => {})));
    this.cache.clear();
  }

  private async serverTools(url: string, label: string, opts: { headers?: Record<string, string>; allow?: string[] } = {}): Promise<Tool[]> {
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.tools;
    await hit?.client.close().catch(() => {});
    this.cache.delete(url);

    await assertPublicUrl(url);
    const client = new Client({ name: 'i-persons', version: '0.1.0' });
    await client.connect(this.transport(url, opts.headers));
    const { tools: all } = await client.listTools();
    // Admin connectors expose only their allowlisted tools (empty list = all).
    const tools = opts.allow?.length ? all.filter((t) => opts.allow!.includes(t.name)) : all;
    const prefix = `mcp_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20)}_`;
    const list: Tool[] = tools.map((t) => ({
      name: (prefix + t.name.replace(/[^a-zA-Z0-9_-]/g, '_')).slice(0, 64),
      description: `${t.description ?? t.name} (via ${label})`,
      risk: 'write',
      external: `mcp:${label}`,
      schema: z.record(z.string(), z.unknown()),
      jsonSchema: t.inputSchema as Record<string, unknown>,
      summarize: (args) => `${label}: ${t.name} ${JSON.stringify(args).slice(0, 160)}`,
      execute: async (_ctx, args) => {
        const res = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> });
        const content = (res.content as { type: string; text?: string }[] | undefined) ?? [];
        const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (res.isError) throw new Error(text || 'MCP tool failed');
        return { text: text.slice(0, 4000) };
      },
    }));
    this.cache.set(url, { client, tools: list, at: Date.now() });
    return list;
  }
}

/** "Bearer x" / "X-Api-Key: y" → a header map. A bare value is sent as a bearer token. */
function authHeader(raw: string): Record<string, string> {
  const m = /^([A-Za-z0-9-]+):\s*(.+)$/.exec(raw.trim());
  return m ? { [m[1]!]: m[2]! } : { Authorization: raw.startsWith('Bearer ') ? raw : `Bearer ${raw}` };
}
