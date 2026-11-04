import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { checkAction } from '../src/agent/rules.ts';
import { AgentRuntime } from '../src/agent/runtime.ts';
import { actions, ipersonRules } from '../src/db/schema.ts';
import type { LlmResult } from '../src/meta/llm.ts';
import { call, FakeLlm, makeIperson, reset, say, testDb } from './helpers.ts';

// Jury §3: rules are checked on every reply (fail open) and always on actions (fail closed: held card).

const { db, pool } = testDb();
beforeEach(() => reset(db));
afterAll(() => pool.end());

const down = (): LlmResult => { throw new Error('checker unavailable'); };
const SUNDAY = { title: 'Brunch', start: '2026-11-08T11:00', end: '2026-11-08T12:00' };

async function setup(steps: ConstructorParameters<typeof FakeLlm>[0], withRule = true) {
  const { iperson } = await makeIperson(db);
  if (withRule) await db.insert(ipersonRules).values({ ipersonId: iperson.id, kind: 'dont', text: 'Never book anything on Sundays', source: 'user' });
  const llm = new FakeLlm(steps);
  const rt = new AgentRuntime({ db, llm });
  return { rt, llm, ipersonId: iperson.id, conversationId: await rt.conversationFor(iperson.id, 'web') };
}

describe('rules on actions', () => {
  it('blocks a proposal that breaks a rule: no card, the model is told which rule', async () => {
    const { rt, llm, ipersonId, conversationId } = await setup([
      call('calendar_book', SUNDAY),
      say('{"ok":false,"violated":[1]}'), // the action check
      say('That would break your rule "Never book anything on Sundays". Saturday instead?'),
      say('{"ok":true}'), // the reply check
    ]);
    const res = await rt.handleUserMessage({ ipersonId, conversationId, text: 'book brunch on Sunday at 11' });
    expect(res.proposed).toHaveLength(0);
    expect(await db.select().from(actions)).toHaveLength(0);
    expect(String(llm.calls[2]!.messages.at(-2)!.content)).toContain('blocked_by_rule');
    expect(String(llm.calls[2]!.messages.at(-2)!.content)).toContain('Never: Never book anything on Sundays');
    expect((await db.select().from(ipersonRules))[0]!.hits).toBe(1);
  });

  it('holds the card when the checker is down: a spoken "yes" is refused, a tap approves', async () => {
    const { rt, ipersonId, conversationId } = await setup([call('calendar_book', SUNDAY), down, say('Here it is, please check it.'), down, say('Booked.'), say('{"ok":true}')]);
    const res = await rt.handleUserMessage({ ipersonId, conversationId, text: 'book brunch on Sunday at 11' });
    // The reply still went out although its check failed too (replies fail open).
    expect(res.reply).toBe('Here it is, please check it.');
    expect(res.proposed[0]).toMatchObject({ status: 'proposed', heldReason: expect.stringContaining('Couldn’t check your rules') });

    const yes = await rt.handleUserMessage({ ipersonId, conversationId, text: 'yes' });
    expect(yes.decided).toBeUndefined();
    expect(yes.reply).toMatch(/needs a tap/);
    expect((await db.select().from(actions).where(eq(actions.id, res.proposed[0]!.id)))[0]!.status).toBe('proposed');

    const tap = await rt.decide({ ipersonId, actionId: res.proposed[0]!.id, approve: true });
    expect(tap.action.status).toBe('done');
  });

  it('does not call the checker when there are no rules, and lets clean proposals through', async () => {
    const free = await setup([call('calendar_book', SUNDAY), say('Shall I book it?')], false);
    const res = await free.rt.handleUserMessage({ ipersonId: free.ipersonId, conversationId: free.conversationId, text: 'book brunch' });
    expect(res.proposed[0]!.heldReason).toBeNull();
    expect(free.llm.calls).toHaveLength(2);
  });

  it('treats a nonsense or timed-out check as unavailable', async () => {
    const rules = [{ id: 'r1', kind: 'dont' as const, text: 'Never book on Sundays' }];
    const p = { tool: 'calendar_book', args: SUNDAY, summary: 'Book "Brunch"' };
    expect(await checkAction(new FakeLlm([say('sure, looks fine')]), rules, p)).toEqual({ verdict: 'unavailable' });
    expect(await checkAction(new FakeLlm([say('{"ok":false,"violated":[7]}')]), rules, p)).toEqual({ verdict: 'unavailable' });
    const slow = { complete: () => new Promise<LlmResult>(() => {}) };
    expect(await checkAction(slow as never, rules, p, 20)).toEqual({ verdict: 'unavailable' });
    expect(await checkAction(new FakeLlm([say('{"ok":true}')]), rules, p)).toEqual({ verdict: 'ok' });
  });
});

describe('simulations flag (jury §9)', () => {
  it('offers the wallet, orders and paper trading only when SHOW_SIMULATIONS is on', async () => {
    const { config } = await import('../src/config.ts');
    const before = config.SHOW_SIMULATIONS;
    try {
      for (const [flag, expected] of [['off', false], ['on', true]] as const) {
        config.SHOW_SIMULATIONS = flag;
        const { llm, rt, ipersonId, conversationId } = await setup([say('Hi.')], false);
        await rt.handleUserMessage({ ipersonId, conversationId, text: 'hi' });
        const names = llm.calls[0]!.tools.map((t) => t.name);
        expect(['place_order', 'paper_trade', 'portfolio_status', 'wallet_status'].every((n) => names.includes(n))).toBe(expected);
        expect(names).toContain('calendar_book');
        expect(String(llm.calls[0]!.messages.at(-1)!.content).includes('Wallet (mock)')).toBe(expected);
        await reset(db);
      }
    } finally {
      config.SHOW_SIMULATIONS = before;
    }
  });
});

describe('WhatsApp guests (Impact §3)', () => {
  it('can chat but not email, use contacts, partners or planning; the twin offers the web link', async () => {
    const { users } = await import('../src/db/schema.ts');
    const { llm, rt, ipersonId, conversationId } = await setup([say('Sure!')], false);
    await db.update(users).set({ guestAt: new Date(), onboardedAt: null });
    await rt.handleUserMessage({ ipersonId, conversationId, text: 'email my boss' });
    const names = llm.calls[0]!.tools.map((t) => t.name);
    for (const blocked of ['send_email', 'contacts_search', 'invite_contact', 'plan_with_contacts']) expect(names).not.toContain(blocked);
    expect(names).toContain('find_opportunities');
    expect(String(llm.calls[0]!.messages.at(-1)!.content)).toContain('{{WEB_LINK}}');
  });
});
