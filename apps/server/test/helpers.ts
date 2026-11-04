import { sql } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { createDb, type Db } from '../src/db/client.ts';
import { ipersons, users, wallets } from '../src/db/schema.ts';
import type { Llm, LlmResult, ToolSpec, ChatMessage } from '../src/meta/llm.ts';

export function testDb() {
  const url = config.TEST_DATABASE_URL;
  if (!url || !/_test(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must point to a *_test database');
  return createDb(url);
}

export async function reset(db: Db) {
  await db.execute(sql`truncate users, ipersons, profile_facts, conversations, messages, connections,
    actions, wallets, paper_positions, calendar_events, notifications, ai_usage, avatar_assets, purchases, bookings, insights, partner_applications, partners, webhook_deliveries, reports cascade`);
}

export async function makeIperson(db: Db, opts: { email?: string; walletCents?: number } = {}) {
  const [user] = await db.insert(users).values({
    email: opts.email ?? 'merry@example.com', name: 'Merry', locale: 'en', timezone: 'Africa/Tunis',
  }).returning();
  const [ip] = await db.insert(ipersons).values({ userId: user!.id, displayName: 'Mimi' }).returning();
  await db.insert(wallets).values({
    ipersonId: ip!.id, balanceCents: opts.walletCents ?? 20_000, currency: 'TND',
    perActionLimitCents: 5_000, monthlyBudgetCents: 10_000,
  });
  return { user: user!, iperson: ip! };
}

type Step = LlmResult | ((req: { messages: ChatMessage[]; tools: ToolSpec[] }) => LlmResult | Promise<LlmResult>);

/** Replays scripted model responses and records every request. */
export class FakeLlm implements Llm {
  calls: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];
  constructor(private steps: Step[], private fallback?: Step) {}
  async complete(req: { messages: ChatMessage[]; tools: ToolSpec[] }): Promise<LlmResult> {
    this.calls.push(req);
    const step = this.steps.shift() ?? this.fallback;
    if (!step) throw new Error('FakeLlm: no scripted response left');
    return typeof step === 'function' ? step(req) : step;
  }
}

let n = 0;
export const say = (content: string): LlmResult => ({ content, toolCalls: [] });
export const call = (name: string, args: unknown, content = ''): LlmResult => ({
  content, toolCalls: [{ id: `call_${++n}`, name, arguments: JSON.stringify(args) }],
});

/** Fake IP → country for tests: 'TN' unless a test sets another (null = unknown). */
export const geoFor: { country: string | null } = { country: 'TN' };
export const testGeo = async () => geoFor.country;
