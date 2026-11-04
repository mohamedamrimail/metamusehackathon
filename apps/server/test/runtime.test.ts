import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActionError, AgentRuntime } from '../src/agent/runtime.ts';
import { builtinTools } from '../src/agent/tools/index.ts';
import { defineTool, type Tool } from '../src/agent/tools/types.ts';
import { actions, calendarEvents, messages, profileFacts, wallets } from '../src/db/schema.ts';
import { call, FakeLlm, makeIperson, reset, say, testDb } from './helpers.ts';

const { db, pool } = testDb();
afterAll(() => pool.end());

let clock = new Date('2026-11-03T10:00:00Z');
const now = () => clock;

beforeEach(async () => {
  await reset(db);
  clock = new Date('2026-11-03T10:00:00Z');
});

async function setup(steps: ConstructorParameters<typeof FakeLlm>[0], tools: Tool[] = builtinTools, fallback?: ConstructorParameters<typeof FakeLlm>[1]) {
  const { iperson } = await makeIperson(db);
  const llm = new FakeLlm(steps, fallback);
  const rt = new AgentRuntime({ db, llm, tools, now });
  const conversationId = await rt.conversationFor(iperson.id, 'web');
  return { rt, llm, ipersonId: iperson.id, conversationId };
}

const yoga = { title: 'Yoga', start: '2026-11-04T18:00', end: '2026-11-04T19:00', location: 'Zen Studio' };

describe('read tools', () => {
  it('run immediately and feed their result back to the model', async () => {
    const { rt, llm, ipersonId, conversationId } = await setup([
      call('remember_fact', { category: 'routine', key: 'Yoga Time', value: 'Tuesday evenings' }),
      say('Got it, Tuesday evenings.'),
    ]);
    const res = await rt.handleUserMessage({ ipersonId, conversationId, text: 'I do yoga on Tuesday evenings' });

    expect(res.reply).toBe('Got it, Tuesday evenings.');
    const facts = await db.select().from(profileFacts);
    expect(facts).toMatchObject([{ category: 'routine', key: 'yoga_time', value: 'Tuesday evenings' }]);
    const toolMsg = llm.calls[1]!.messages.at(-2)!;
    expect(toolMsg).toMatchObject({ role: 'tool' });
    expect(JSON.parse(toolMsg.content as string)).toMatchObject({ saved: true });
  });

  it('puts known facts in the per-turn context, after a cacheable prefix', async () => {
    const { rt, llm, ipersonId, conversationId } = await setup([say('hi')]);
    await db.insert(profileFacts).values({ ipersonId, category: 'preference', key: 'travel', value: 'beach trips' });
    await rt.handleUserMessage({ ipersonId, conversationId, text: 'hello' });
    const msgs = llm.calls[0]!.messages;
    expect(msgs.at(-1)).toMatchObject({ role: 'system' });
    expect(msgs.at(-1)!.content).toContain('preference/travel: beach trips');
    expect(msgs.at(-1)!.content).toContain('Now: ');
    // The system prompt is the same on every turn, so Meta's prefix cache can reuse it.
    await rt.handleUserMessage({ ipersonId, conversationId, text: 'again' }).catch(() => {});
    expect(msgs[0]!.content).not.toContain('beach trips');
    expect(msgs[0]!.content).not.toMatch(/Now: /);
  });

  it('returns validation errors to the model instead of throwing', async () => {
    const { rt, llm, ipersonId, conversationId } = await setup([
      call('remember_fact', { category: 'nonsense', key: 'x', value: 'y' }),
      call('no_such_tool', {}),
      say('ok'),
    ]);
    await rt.handleUserMessage({ ipersonId, conversationId, text: 'hi' });
    expect(llm.calls[1]!.messages.at(-2)!.content).toContain('invalid arguments');
    expect(llm.calls[2]!.messages.at(-2)!.content).toContain('unknown tool');
  });
});

describe('write tools need confirmation', () => {
  it('only creates a proposal; nothing is booked', async () => {
    const { rt, llm, ipersonId, conversationId } = await setup([
      call('calendar_book', yoga),
      say('Shall I book Wednesday 6 PM yoga?'),
    ]);
    const res = await rt.handleUserMessage({ ipersonId, conversationId, text: 'book me yoga tomorrow 6pm' });

    expect(res.proposed).toHaveLength(1);
    expect(res.proposed[0]).toMatchObject({ status: 'proposed', risk: 'write', tool: 'calendar_book' });
    expect(res.proposed[0]!.summary).toBe('Book "Yoga" on Wednesday 2026-11-04 18:00 at Zen Studio');
    expect(await db.select().from(calendarEvents)).toHaveLength(0);
    expect(JSON.parse(llm.calls[1]!.messages.at(-2)!.content as string)).toMatchObject({ status: 'awaiting_confirmation' });
  });

  it('runs on approve, then the model reports the result', async () => {
    const { rt, llm, ipersonId, conversationId } = await setup([
      call('calendar_book', yoga), say('Shall I book it?'), say('Done, yoga is booked.'),
    ]);
    const { proposed } = await rt.handleUserMessage({ ipersonId, conversationId, text: 'book yoga' });
    const { action, followUp } = await rt.decide({ ipersonId, actionId: proposed[0]!.id, approve: true });

    expect(action.status).toBe('done');
    expect(followUp?.reply).toBe('Done, yoga is booked.');
    const [ev] = await db.select().from(calendarEvents);
    expect(ev!.startsAt.toISOString()).toBe('2026-11-04T17:00:00.000Z'); // 18:00 Tunis = 17:00 UTC
    expect(llm.calls[2]!.messages.at(-2)!.content).toContain('approved and done');
  });

  it('is single-use', async () => {
    const { rt, ipersonId, conversationId } = await setup([call('calendar_book', yoga), say('?'), say('done')]);
    const { proposed } = await rt.handleUserMessage({ ipersonId, conversationId, text: 'book yoga' });
    await rt.decide({ ipersonId, token: proposed[0]!.confirmToken, approve: true });
    await expect(rt.decide({ ipersonId, token: proposed[0]!.confirmToken, approve: true }))
      .rejects.toMatchObject({ code: 'already_decided' });
    expect(await db.select().from(calendarEvents)).toHaveLength(1);
  });

  it('expires after 10 minutes', async () => {
    const { rt, ipersonId, conversationId } = await setup([call('calendar_book', yoga), say('?')]);
    const { proposed } = await rt.handleUserMessage({ ipersonId, conversationId, text: 'book yoga' });
    clock = new Date(clock.getTime() + 10 * 60_000 + 1);
    await expect(rt.decide({ ipersonId, actionId: proposed[0]!.id, approve: true }))
      .rejects.toBeInstanceOf(ActionError);
    const [row] = await db.select().from(actions);
    expect(row!.status).toBe('expired');
    expect(await db.select().from(calendarEvents)).toHaveLength(0);
  });

  it("cannot be confirmed by another user's i-person", async () => {
    const { rt, ipersonId, conversationId } = await setup([call('calendar_book', yoga), say('?')]);
    const { proposed } = await rt.handleUserMessage({ ipersonId, conversationId, text: 'book yoga' });
    const other = await makeIperson(db, { email: 'eve@example.com' });
    await expect(rt.decide({ ipersonId: other.iperson.id, actionId: proposed[0]!.id, approve: true }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('declining logs it and runs nothing', async () => {
    const { rt, ipersonId, conversationId } = await setup([call('calendar_book', yoga), say('?')]);
    const { proposed } = await rt.handleUserMessage({ ipersonId, conversationId, text: 'book yoga' });
    const { action } = await rt.decide({ ipersonId, actionId: proposed[0]!.id, approve: false });
    expect(action.status).toBe('rejected');
    expect(await db.select().from(calendarEvents)).toHaveLength(0);
  });

  it('a spoken "yes" approves the single pending proposal', async () => {
    const { rt, ipersonId, conversationId } = await setup([call('calendar_book', yoga), say('Shall I?'), say('Booked!')]);
    await rt.handleUserMessage({ ipersonId, conversationId, text: 'book yoga' });
    const res = await rt.handleUserMessage({ ipersonId, conversationId, text: 'Yes please!' });
    expect(res.decided?.status).toBe('done');
    expect(res.reply).toBe('Booked!');
  });

  it('"yes" with nothing pending is a normal turn', async () => {
    const { rt, ipersonId, conversationId } = await setup([say('Yes to what?')]);
    const res = await rt.handleUserMessage({ ipersonId, conversationId, text: 'yes' });
    expect(res.decided).toBeUndefined();
    expect(res.reply).toBe('Yes to what?');
  });
});

describe('money tools', () => {
  const order = defineTool({
    name: 'test_order',
    description: 'test order',
    risk: 'money',
    schema: z.object({ total: z.number(), fail: z.boolean().optional() }),
    amount: (a) => ({ cents: Math.round(a.total * 100), currency: 'TND' }),
    summarize: (a) => `Order for ${a.total} TND`,
    async execute(_ctx, a) {
      if (a.fail) throw new Error('merchant down');
      return { ordered: true };
    },
  }) as Tool;

  const balance = async () => (await db.select().from(wallets))[0]!;

  it('refuses to propose above the per-action limit', async () => {
    const { rt, llm, ipersonId, conversationId } = await setup([call('test_order', { total: 80 }), say('Too much.')], [order]);
    const res = await rt.handleUserMessage({ ipersonId, conversationId, text: 'order' });
    expect(res.proposed).toHaveLength(0);
    expect(llm.calls[1]!.messages.at(-2)!.content).toContain('per-action limit');
  });

  it('debits the wallet on approve', async () => {
    const { rt, ipersonId, conversationId } = await setup([call('test_order', { total: 15 }), say('?'), say('done')], [order]);
    const { proposed } = await rt.handleUserMessage({ ipersonId, conversationId, text: 'order' });
    expect(proposed[0]).toMatchObject({ amountCents: 1500, currency: 'TND' });
    await rt.decide({ ipersonId, actionId: proposed[0]!.id, approve: true });
    expect(await balance()).toMatchObject({ balanceCents: 18_500, spentThisMonthCents: 1500, spentMonth: '2026-11' });
  });

  it('refunds when the action fails', async () => {
    const { rt, ipersonId, conversationId } = await setup([call('test_order', { total: 15, fail: true }), say('?'), say('failed')], [order]);
    const { proposed } = await rt.handleUserMessage({ ipersonId, conversationId, text: 'order' });
    const { action } = await rt.decide({ ipersonId, actionId: proposed[0]!.id, approve: true });
    expect(action).toMatchObject({ status: 'failed', result: { error: 'merchant down' } });
    expect(await balance()).toMatchObject({ balanceCents: 20_000, spentThisMonthCents: 0 });
  });

  it('re-checks the monthly budget at confirm time', async () => {
    const { rt, ipersonId, conversationId } = await setup([call('test_order', { total: 40 }), say('?'), say('no')], [order]);
    const { proposed } = await rt.handleUserMessage({ ipersonId, conversationId, text: 'order' });
    await db.update(wallets).set({ spentThisMonthCents: 7_000, spentMonth: '2026-11' }).where(eq(wallets.ipersonId, ipersonId));
    const { action } = await rt.decide({ ipersonId, actionId: proposed[0]!.id, approve: true });
    expect(action.status).toBe('failed');
    expect(JSON.stringify(action.result)).toContain('monthly budget');
  });
});

describe('turn loop', () => {
  it('caps tool calls at 8 per turn, then asks for a plain answer', async () => {
    const { rt, llm, ipersonId, conversationId } = await setup(
      [], builtinTools,
      (req) => req.tools.length ? call('get_profile', {}) : say('Here is what I found.'),
    );
    const res = await rt.handleUserMessage({ ipersonId, conversationId, text: 'loop forever' });
    expect(res.reply).toBe('Here is what I found.');
    expect(llm.calls).toHaveLength(9);
    expect(llm.calls.at(-1)!.tools).toHaveLength(0);
  });

  it('keeps history across turns, with tool calls paired to results', async () => {
    const { rt, llm, ipersonId, conversationId } = await setup([call('get_profile', {}), say('one'), say('two')]);
    await rt.handleUserMessage({ ipersonId, conversationId, text: 'first' });
    await rt.handleUserMessage({ ipersonId, conversationId, text: 'second' });
    const roles = llm.calls[2]!.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user', 'system']);
  });
});

describe('mood tags', () => {
  it('strips the tag from what is said and stored, and returns the mood', async () => {
    const { rt, ipersonId, conversationId } = await setup([say('[mood:happy] Booked! Enjoy yoga.')]);
    const res = await rt.handleUserMessage({ ipersonId, conversationId, text: 'thanks' });
    expect(res).toMatchObject({ reply: 'Booked! Enjoy yoga.', mood: 'happy' });
    const stored = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(stored.map((m) => m.content).join(' ')).not.toContain('[mood');
  });
});


describe('one conversation, two turns at once', () => {
  // The model refuses a history where a tool call isn't followed by its results (Meta API: "Missing tool response").
  type Msg = { role: string; tool_calls?: { id: string }[]; tool_call_id?: string };
  const strict = (req: { messages: unknown[] }) => {
    const m = req.messages as Msg[];
    for (let i = 0; i < m.length; i++) {
      for (const c of m[i]!.tool_calls ?? []) {
        let j = i + 1;
        while (j < m.length && m[j]!.role === 'tool' && m[j]!.tool_call_id !== c.id) j++;
        if (j >= m.length || m[j]!.role !== 'tool') throw new Error(`400 Missing tool response for tool_call_id(s): ${c.id}`);
      }
    }
  };
  const slowFact = (key: string) => async (req: { messages: unknown[] }) => { strict(req); await new Promise((r) => setTimeout(r, 30)); return call('remember_fact', { category: 'routine', key, value: 'x' }); };
  const reply = (text: string) => async (req: { messages: unknown[] }) => { strict(req); return say(text); };

  it('runs them one after the other, so tool calls and results never interleave', async () => {
    const { rt, ipersonId, conversationId } = await setup([slowFact('a'), reply('first'), slowFact('b'), reply('second')]);
    const [a, b] = await Promise.all([
      rt.handleNotice({ ipersonId, conversationId, text: 'The user just finished setting you up.' }),
      rt.handleUserMessage({ ipersonId, conversationId, text: 'Plan a coffee with my mom' }),
    ]);
    expect([a.reply, b.reply]).toEqual(['first', 'second']);
  });

  it('leaves out a tool call that never got its results (an older broken turn)', async () => {
    const { rt, ipersonId, conversationId } = await setup([reply('fine')]);
    await db.insert(messages).values({ conversationId, role: 'assistant', content: '', toolCalls: [{ id: 'call_lost', name: 'calendar_list', arguments: '{}' }] });
    expect((await rt.handleUserMessage({ ipersonId, conversationId, text: 'hello' })).reply).toBe('fine');
  });
});
