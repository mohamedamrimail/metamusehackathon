import { showSimulations, SIMULATION_TOOLS } from '../config.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { clip, logCall, tagLlm, withCall, withPurpose } from '../lib/call-log.ts';
import { GUEST_BLOCKED_TOOLS, GUEST_RULE, isGuest } from '../channels/guest.ts';
import type { Channel } from '@ipersons/shared';
import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { actions, connectors, conversations, ipersons, messages, userServices, users } from '../db/schema.ts';
import type { ChatMessage, Llm, LlmToolCall } from '../meta/llm.ts';
import { connectorVisibleTo, isDemoAccount, neutralBrands, splitMood, type Mood } from '@ipersons/shared';
import { hasCredit, meteredLlm } from '../billing/credits.ts';
import { markModelResponse } from '../lib/latency.ts';
import { wrapUntrusted } from './untrusted.ts';
import { confirmIntent } from './confirm-intent.ts';
import { listFacts } from './memory.ts';
import { activeRules, checkAction, checkReply, countHits, formatRules, preferredSources, type Rule } from './rules.ts';
import { buildSystemPrompt, buildTurnContext } from './prompt.ts';
import { builtinTools } from './tools/index.ts';
import { toToolSpec, type PendingMemory, type Tool, type ToolContext } from './tools/types.ts';
import { charge, getWallet, refund, walletRefusal, WalletError } from './wallet.ts';

export type ActionRow = typeof actions.$inferSelect;

export interface TurnResult {
  reply: string;
  /** Actions proposed during this turn, waiting for the user's yes. */
  proposed: ActionRow[];
  /** Set when the turn was a spoken yes/no that decided a pending action. */
  decided?: ActionRow;
  /** The reply's mood for the avatar (the tag itself is stripped from `reply`). */
  mood?: Mood;
  /** Facts or rules learned after reading outside content, waiting for the user's Keep / Discard. */
  pendingMemory?: PendingMemory[];
}

const isUserTurn = (m: ChatMessage) => m.role === 'user' && !String(m.content ?? '').startsWith('[i-persons system notice');

/**
 * Outside sources the model saw since the user's previous message (in tool results or notices), so a
 * fact or rule it wants to save right after reading them waits for the user's keep.
 */
export function recentOutsideSources(history: ChatMessage[]): string[] {
  let start = 0;
  for (let i = history.length - 1, users = 0; i >= 0; i--) {
    if (isUserTurn(history[i]!) && ++users === 2) { start = i; break; }
  }
  const out = new Set<string>();
  for (const m of history.slice(start)) {
    if (isUserTurn(m)) continue; // what the user typed is theirs, even if it looks like a tag
    for (const x of String(m.content ?? '').matchAll(/<untrusted source="([^"]+)"/g)) out.add(x[1]!);
  }
  return [...out];
}

export interface DecisionResult {
  action: ActionRow;
  /** The model's spoken follow-up ("Done, yoga is booked."), when the action ran. */
  followUp?: TurnResult;
}

export class ActionError extends Error {
  constructor(public code: 'not_found' | 'expired' | 'already_decided', message: string) {
    super(message);
  }
}

export interface RuntimeOptions {
  db: Db;
  llm: Llm;
  tools?: Tool[];
  now?: () => Date;
  /** SPEC: loop cap of 8 tool calls per turn. */
  maxToolCalls?: number;
  /** SPEC: confirmations expire after 10 minutes. */
  confirmTtlMs?: number;
  historyLimit?: number;
  /** Per-i-person tools on top of the built-ins (connected MCP servers). */
  extraTools?: (ipersonId: string) => Promise<Tool[]>;
  /** Charge model calls to the user's AI credit (off in demo mode, where nothing costs anything). */
  credits?: { model: string };
  /** Called after an action is declined or expires (partner requests tell the partner). */
  onSettled?: (action: ActionRow) => Promise<void>;
  /** Sends a message to the owner's own verified WhatsApp number (undefined when WhatsApp isn't set up). */
  whatsapp?: (to: string, text: string, image?: { data: Buffer; mime: string }) => Promise<void>;
}

export const NO_CREDIT_REPLY = "You've used all your AI credit, so I can't think this through right now. Top up on the My twin page.";

const FALLBACK_REPLY = "Sorry, I lost my train of thought. Could you say that again?";

/** The conversations whose turn is running in this async context (nested turns in one of them skip the queue). */
const turnLock = new AsyncLocalStorage<Set<string>>();

export class AgentRuntime {
  private db: Db;
  private llm: Llm;
  private tools: Map<string, Tool>;
  private now: () => Date;
  private maxToolCalls: number;
  private confirmTtlMs: number;
  private historyLimit: number;
  private extraTools?: (ipersonId: string) => Promise<Tool[]>;
  private credits?: { model: string };
  private whatsapp?: (to: string, text: string, image?: { data: Buffer; mime: string }) => Promise<void>;
  private onSettled?: (action: ActionRow) => Promise<void>;

  constructor(opts: RuntimeOptions) {
    this.db = opts.db;
    this.llm = opts.llm;
    // Simulations (mock wallet, orders, paper trading) are only offered when SHOW_SIMULATIONS is on.
    this.tools = new Map((opts.tools ?? builtinTools).filter((t) => showSimulations() || !SIMULATION_TOOLS.has(t.name)).map((t) => [t.name, t]));
    this.now = opts.now ?? (() => new Date());
    this.maxToolCalls = opts.maxToolCalls ?? 8;
    this.confirmTtlMs = opts.confirmTtlMs ?? 10 * 60_000;
    this.historyLimit = opts.historyLimit ?? 40;
    this.extraTools = opts.extraTools;
    this.credits = opts.credits;
    this.onSettled = opts.onSettled;
    this.whatsapp = opts.whatsapp;
  }

  private async toolsFor(ipersonId: string): Promise<Map<string, Tool>> {
    if (!this.extraTools) return this.tools;
    const extra = await this.extraTools(ipersonId).catch(() => []);
    if (!extra.length) return this.tools;
    const all = new Map(this.tools);
    for (const t of extra) if (!all.has(t.name)) all.set(t.name, t);
    return all;
  }

  /** The ongoing conversation for a channel; one per i-person and channel. */
  async conversationFor(ipersonId: string, channel: Channel): Promise<string> {
    const [existing] = await this.db.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.ipersonId, ipersonId), eq(conversations.channel, channel)))
      .orderBy(desc(conversations.createdAt)).limit(1);
    if (existing) return existing.id;
    const [created] = await this.db.insert(conversations).values({ ipersonId, channel }).returning({ id: conversations.id });
    return created!.id;
  }

  /** Entry point for anything the user says or types, on any channel. */
  async handleUserMessage(input: { ipersonId: string; conversationId: string; text: string }): Promise<TurnResult> {
    await this.expireStale(input.ipersonId);

    // A bare "yes"/"no" with exactly one proposal pending in this conversation decides it here,
    // in the runtime; the model never gets to execute anything itself.
    const intent = confirmIntent(input.text);
    if (intent) {
      const pending = await this.pendingActions(input.ipersonId, input.conversationId);
      if (pending.length === 1 && intent === 'yes' && pending[0]!.heldReason) {
        // A held card (rules couldn't be checked) needs an explicit tap, never a bare "yes".
        await this.saveMessage(input.conversationId, { role: 'user', content: input.text });
        const reply = 'I couldn’t check this one against your rules, so it needs a tap: please review the card and tap Approve if it’s right.';
        await this.saveMessage(input.conversationId, { role: 'assistant', content: reply });
        return { reply, proposed: [] };
      }
      if (pending.length === 1) {
        await this.saveMessage(input.conversationId, { role: 'user', content: input.text });
        const { action, followUp } = await this.decide({
          ipersonId: input.ipersonId, actionId: pending[0]!.id, approve: intent === 'yes',
        });
        return {
          reply: followUp?.reply ?? (intent === 'no' ? 'Okay, I won’t do it.' : ''),
          proposed: followUp?.proposed ?? [],
          decided: action,
        };
      }
    }
    return this.runTurn(input.ipersonId, input.conversationId, 'user', input.text);
  }

  /** A turn started by the system (e.g. the end of setup), not by something the user said. */
  async handleNotice(input: { ipersonId: string; conversationId: string; text: string }): Promise<TurnResult> {
    return this.runTurn(input.ipersonId, input.conversationId, 'notice', input.text);
  }

  /**
   * Approves or declines a proposed action, by id (web) or confirm token (WhatsApp buttons).
   * Single use: only a still-proposed, unexpired action of this i-person can be decided.
   */
  async decide(input: {
    ipersonId: string; actionId?: string; token?: string; approve: boolean;
  }): Promise<DecisionResult> {
    if (!input.actionId && !input.token) throw new ActionError('not_found', 'action id or token required');
    const now = this.now();
    const match = and(
      eq(actions.ipersonId, input.ipersonId),
      input.actionId ? eq(actions.id, input.actionId) : eq(actions.confirmToken, input.token!),
    );

    const [claimed] = await this.db.update(actions)
      .set({ status: input.approve ? 'confirmed' : 'rejected', decidedAt: now })
      .where(and(match, eq(actions.status, 'proposed'), gt(actions.expiresAt, now)))
      .returning();

    if (!claimed) {
      const [row] = await this.db.select().from(actions).where(match);
      if (!row) throw new ActionError('not_found', 'no such action');
      if (row.status === 'proposed') {
        const [expired] = await this.db.update(actions).set({ status: 'expired' }).where(eq(actions.id, row.id)).returning();
        await this.onSettled?.(expired!).catch(() => {});
        throw new ActionError('expired', 'this confirmation has expired; ask again');
      }
      throw new ActionError('already_decided', `action is already ${row.status}`);
    }

    const owner = { userId: (await this.loadIperson(input.ipersonId)).user.id };
    void logCall({ service: 'Approval gate', what: `${input.approve ? 'Approved' : 'Declined'}: ${claimed.summary}` }, owner);
    if (!input.approve) {
      await this.onSettled?.(claimed).catch(() => {});
      if (claimed.conversationId) {
        await this.saveMessage(claimed.conversationId, {
          role: 'notice', content: `The user declined: ${claimed.summary} (action ${claimed.id}). Do not retry it unless asked.`,
        });
      }
      return { action: claimed };
    }

    const action = await withCall(owner, () => this.execute(claimed));
    void logCall({ service: action.tool.startsWith('calendar') ? 'Calendar' : action.tool === 'send_email' ? 'Email' : 'Tool', what: `${action.tool} ${action.status}${resultNote(action.result)}`, ok: action.status === 'done' }, owner);
    if (!action.conversationId) return { action };

    // Results from outside services (MCP) come back wrapped as untrusted data too.
    const external = (await this.toolsFor(action.ipersonId)).get(action.tool)?.external;
    const resultText = external ? wrapUntrusted(external, JSON.stringify(action.result), action.id) : JSON.stringify(action.result);
    const outcome = action.status === 'done'
      ? `was approved and done. Result: ${resultText}`
      : `was approved but failed: ${resultText}`;
    const followUp = await this.runTurn(
      action.ipersonId, action.conversationId, 'notice',
      `Action "${action.summary}" (${action.id}) ${outcome}. Tell the user in one short sentence.`,
    );
    return { action, followUp };
  }

  async pendingActions(ipersonId: string, conversationId?: string): Promise<ActionRow[]> {
    return this.db.select().from(actions).where(and(
      eq(actions.ipersonId, ipersonId),
      eq(actions.status, 'proposed'),
      gt(actions.expiresAt, this.now()),
      conversationId ? eq(actions.conversationId, conversationId) : undefined,
    )).orderBy(asc(actions.createdAt));
  }

  async expireStale(ipersonId?: string): Promise<void> {
    const gone = await this.db.update(actions).set({ status: 'expired' }).where(and(
      ipersonId ? eq(actions.ipersonId, ipersonId) : undefined, eq(actions.status, 'proposed'), lte(actions.expiresAt, this.now()),
    )).returning();
    for (const a of gone) await this.onSettled?.(a).catch(() => {});
  }

  // --- internals ---

  private async execute(action: ActionRow): Promise<ActionRow> {
    const tool = (await this.toolsFor(action.ipersonId)).get(action.tool);
    const finish = async (status: 'done' | 'failed', result: unknown) => {
      const [row] = await this.db.update(actions).set({ status, result }).where(eq(actions.id, action.id)).returning();
      return row!;
    };
    if (!tool) return finish('failed', { error: `tool ${action.tool} is no longer available` });

    const parsed = tool.schema.safeParse(action.args);
    if (!parsed.success) return finish('failed', { error: 'stored arguments are invalid' });

    const ctx = await this.toolContext(action.ipersonId);
    let charged = 0;
    if (tool.risk === 'money' && action.amountCents != null && action.currency) {
      try {
        await charge(this.db, action.ipersonId, action.amountCents, action.currency, ctx.now);
        charged = action.amountCents;
      } catch (err) {
        if (err instanceof WalletError) return finish('failed', { error: err.message });
        throw err;
      }
    }

    try {
      return await finish('done', (await tool.execute(ctx, parsed.data)) ?? { ok: true });
    } catch (err) {
      if (charged) await refund(this.db, action.ipersonId, charged);
      return finish('failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async runTurn(
    ipersonId: string, conversationId: string, role: 'user' | 'notice', text: string,
  ): Promise<TurnResult> {
    // DEMO: everything this turn does (tools, cards, rules) is owned by this user in the Meta AI calls panel.
    const { user: owner } = await this.loadIperson(ipersonId);
    // One turn at a time per conversation: two at once (a system notice and the user's message) interleave their
    // tool calls and results, and the model then refuses the history. A nested turn in the same one runs directly.
    if (turnLock.getStore()?.has(conversationId)) return withCall({ userId: owner.id }, () => this.runTurnAs(ipersonId, conversationId, role, text));
    const prev = this.turns.get(conversationId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => turnLock.run(new Set([...(turnLock.getStore() ?? []), conversationId]),
      () => withCall({ userId: owner.id }, () => this.runTurnAs(ipersonId, conversationId, role, text))));
    this.turns.set(conversationId, run);
    try {
      return await run;
    } finally {
      if (this.turns.get(conversationId) === run) this.turns.delete(conversationId);
    }
  }

  private turns = new Map<string, Promise<unknown>>();

  private async runTurnAs(
    ipersonId: string, conversationId: string, role: 'user' | 'notice', text: string,
  ): Promise<TurnResult> {
    const { iperson, user } = await this.loadIperson(ipersonId);
    await this.saveMessage(conversationId, { role, content: text });
    if (this.credits && !(await hasCredit(this.db, user.id))) {
      await this.saveMessage(conversationId, { role: 'assistant', content: NO_CREDIT_REPLY });
      return { reply: NO_CREDIT_REPLY, proposed: [] };
    }
    // Every model call of this turn, tool sub-calls included, is charged to the user.
    // DEMO: every call of the turn is owned by this user in the Meta AI calls panel (lib/call-log.ts).
    const llm = tagLlm(this.credits ? meteredLlm(this.llm, this.db, user.id, this.credits.model) : this.llm, { userId: user.id, purpose: role === 'notice' ? 'Agent follow-up' : 'Agent turn' });
    const send = this.whatsapp;
    // Sources of untrusted content read during this turn (provenance for proposals and memory writes).
    const influence = new Set<string>();
    let seenBefore: string[] = [];
    const pendingMemory: PendingMemory[] = [];
    const demo = isDemoAccount(user.accountKind);
    const ctx: ToolContext = {
      db: this.db, llm, ipersonId, userName: user.name, timezone: user.timezone, now: this.now(), demo,
      whatsappOwner: user.phoneE164 && send ? (text, image) => send(user.phoneE164!, text, image) : undefined,
      influence: () => [...new Set([...influence, ...seenBefore])],
      onPendingMemory: (item) => pendingMemory.push(item),
    };

    const proposed: ActionRow[] = [];
    const tools = new Map(await this.toolsFor(ipersonId)); // a copy: the shared map is never changed
    // People the user knows are only looked up when the user asks, never in system-started turns.
    if (role === 'notice') for (const t of ['contacts_search', 'contacts_status']) tools.delete(t);
    // WhatsApp guests (Impact §3): no email, contacts, partners or planning until they finish on the web.
    const guest = isGuest(user);
    if (guest) for (const t of GUEST_BLOCKED_TOOLS) tools.delete(t);
    // DEMO: demo accounts' twins hear the neutral service names (StayFinder, FlyNow, ShopMate), never real brands.
    const specs = [...tools.values()].filter((t) => !t.internal).map(toToolSpec)
      .map((s) => (demo ? { ...s, description: neutralBrands(s.description) } : s));
    let used = 0;

    const prompt = buildSystemPrompt({
      displayName: iperson.displayName, userName: user.name, timezone: user.timezone, locale: user.locale,
    });
    const system = demo ? neutralBrands(prompt) : prompt;
    const [services, rules, sources] = await Promise.all([
      this.servicesFor(user.id, user.accountKind), activeRules(this.db, ipersonId), preferredSources(this.db, ipersonId),
    ]);
    for (;;) {
      const [facts, pending, wallet, history] = await Promise.all([
        listFacts(this.db, ipersonId, { limit: 60 }),
        this.pendingActions(ipersonId),
        showSimulations() ? getWallet(this.db, ipersonId) : Promise.resolve(undefined),
        this.loadHistory(conversationId),
      ]);
      seenBefore = recentOutsideSources(history);
      const context = buildTurnContext({
        timezone: user.timezone, now: ctx.now, facts, pendingActions: pending, wallet, services,
        rules: rules.length ? formatRules(rules) : undefined, sources, currency: user.currency,
      }) + (guest ? `\n${GUEST_RULE}` : '');

      const allowTools = used < this.maxToolCalls;
      const res = await llm.complete({
        messages: [{ role: 'system', content: system }, ...history, { role: 'system', content: context }],
        tools: allowTools ? specs : [],
      });
      markModelResponse(); // voice latency: the first model response of a voice turn (lib/latency.ts)

      if (!allowTools || res.toolCalls.length === 0) {
        // The control check: a reply that breaks one of the user's rules is corrected before it goes out.
        const checked = rules.length ? await withPurpose('Rules check on the reply', () => checkReply(llm, rules, text, res.content)) : await checkReply(llm, rules, text, res.content);
        if (rules.length) void logCall({ service: 'Rules', what: checked.ok ? `reply checked against ${rules.length} rule(s): OK` : `reply rewritten: broke "${checked.violated.length} rule(s)"` }, { userId: user.id });
        if (!checked.ok) await countHits(this.db, checked.violated);
        const { mood, text: said } = splitMood(checked.reply);
        const reply = said || FALLBACK_REPLY;
        await this.saveMessage(conversationId, { role: 'assistant', content: reply, metaResponseId: res.id });
        return { reply, proposed, mood, ...(pendingMemory.length ? { pendingMemory } : {}) };
      }

      await this.saveMessage(conversationId, {
        role: 'assistant', content: splitMood(res.content).text, toolCalls: res.toolCalls, metaResponseId: res.id,
      });
      for (const call of res.toolCalls) {
        used++;
        const result = used > this.maxToolCalls
          ? { error: 'tool call limit for this turn reached; answer the user now' }
          : await this.handleToolCall(tools, ctx, conversationId, call, proposed, influence, rules);
        await this.saveMessage(conversationId, {
          // Wrapped untrusted blocks are already text; everything else is sent as JSON.
          role: 'tool', content: typeof result === 'string' ? result : JSON.stringify(result), toolCalls: { tool_call_id: call.id },
        });
      }
    }
  }

  private async handleToolCall(
    tools: Map<string, Tool>, ctx: ToolContext, conversationId: string, call: LlmToolCall, proposed: ActionRow[],
    influence: Set<string> = new Set(), rules: Rule[] = [],
  ): Promise<unknown> {
    const tool = tools.get(call.name);
    if (!tool || tool.internal) return { error: `unknown tool ${call.name}` };

    let raw: unknown;
    try {
      raw = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return { error: 'arguments are not valid JSON' };
    }
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success) return { error: 'invalid arguments', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
    let args = parsed.data;

    if (tool.risk === 'read') {
      try {
        const result = (await withPurpose(`Tool ${tool.name}`, () => tool.execute(ctx, args))) ?? { ok: true };
        void logCall({ service: 'Tool', what: `${tool.name} (read) ran${tool.external ? ' — result wrapped as untrusted data' : ''}` });
        // DEMO: a tool may name its source differently on demo accounts (e.g. find_offers reads sample listings there).
        const source = (ctx.demo && tool.demoExternal) || tool.external;
        if (!source) return result;
        // Outside content: wrapped as data, and remembered for this turn's provenance.
        influence.add(source);
        return wrapUntrusted(source, JSON.stringify(result), call.id);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    // write / money: never executed here — only proposed (if the tool's own checks allow it at all).
    if (tool.prepare) args = await tool.prepare(ctx, args).catch(() => args);
    const blocked = await tool.check?.(ctx, args).catch((err: Error) => err.message);
    if (blocked) return { error: `cannot propose: ${blocked}` };
    let summary: string;
    try {
      summary = tool.summarize?.(args, ctx) ?? `${tool.name} ${JSON.stringify(args)}`;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const amount = tool.amount?.(args);
    // Money tools without an amount (paper trades) still need a yes, but touch no wallet.
    if (tool.risk === 'money' && amount) {
      const wallet = await getWallet(this.db, ctx.ipersonId);
      const refusal = wallet ? walletRefusal(wallet, amount.cents, amount.currency, ctx.now) : 'no wallet set up';
      if (refusal) return { error: `cannot propose: ${refusal}` };
    }

    // Jury §3: the user's rules are always checked on actions, and this check fails closed.
    const check = await withPurpose('Rules check on the action', () => checkAction(ctx.llm, rules, { tool: tool.name, args, summary }));
    void logCall({ service: 'Rules', what: `action "${clip(summary, 60)}" vs ${rules.length} rule(s): ${check.verdict}` });
    if (check.verdict === 'blocked') {
      await countHits(this.db, check.rules.map((r) => r.id));
      return {
        error: 'blocked_by_rule', rules: check.rules.map((r) => `${r.kind === 'do' ? 'Always' : 'Never'}: ${r.text}`),
        note: 'Do not propose this. Tell the user which of their rules blocked it, and offer an alternative that respects it.',
      };
    }

    const [action] = await this.db.insert(actions).values({
      ipersonId: ctx.ipersonId,
      conversationId,
      tool: tool.name,
      args,
      risk: tool.risk,
      summary,
      amountCents: amount?.cents,
      currency: amount?.currency,
      confirmToken: randomBytes(18).toString('base64url'),
      expiresAt: new Date(ctx.now.getTime() + this.confirmTtlMs),
      influencedBy: influence.size ? [...influence].join(', ') : null,
      heldReason: check.verdict === 'unavailable' ? 'Couldn’t check your rules — review carefully' : null,
    }).returning();
    proposed.push(action!);
    void logCall({ service: 'Approval gate', what: `card waiting for a yes: ${summary}${action!.influencedBy ? ` (⚠ after reading ${action!.influencedBy})` : ''}` });
    return { status: 'awaiting_confirmation', action_id: action!.id, summary };
  }

  private async loadHistory(conversationId: string): Promise<ChatMessage[]> {
    const rows = (await this.db.select().from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.seq)).limit(this.historyLimit)).reverse();
    // A cut window may start with tool results whose assistant call fell outside it.
    while (rows[0]?.role === 'tool') rows.shift();
    // Every tool call needs its results right after it: a turn that broke off (or older interleaved turns) would
    // otherwise make the model refuse the whole history. Incomplete calls and stray results are left out.
    const kept: typeof rows = [];
    for (let i = 0; i < rows.length; i++) {
      const m = rows[i]!;
      const calls = m.role === 'assistant' ? ((m.toolCalls as LlmToolCall[] | null) ?? []) : [];
      if (m.role === 'tool') continue; // added with their call below
      if (!calls.length) { kept.push(m); continue; }
      const results: typeof rows = [];
      for (let j = i + 1; j < rows.length && rows[j]!.role === 'tool'; j++) results.push(rows[j]!);
      const ids = new Set(results.map((r) => (r.toolCalls as { tool_call_id: string }).tool_call_id));
      if (calls.every((c) => ids.has(c.id))) kept.push(m, ...results.filter((r) => calls.some((c) => c.id === (r.toolCalls as { tool_call_id: string }).tool_call_id)));
      else if (m.content) kept.push({ ...m, toolCalls: null });
    }
    rows.splice(0, rows.length, ...kept);

    return rows.map((m): ChatMessage => {
      switch (m.role) {
        case 'assistant': {
          const calls = (m.toolCalls as LlmToolCall[] | null) ?? [];
          return calls.length
            ? {
                role: 'assistant', content: m.content || null,
                tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
              }
            : { role: 'assistant', content: m.content };
        }
        case 'tool':
          return { role: 'tool', tool_call_id: (m.toolCalls as { tool_call_id: string }).tool_call_id, content: m.content };
        case 'notice':
          // HACKATHON: sent as a user turn; not every OpenAI-compatible API accepts mid-chat system messages.
          return { role: 'user', content: `[i-persons system notice, not from the user] ${m.content}` };
        default:
          return { role: 'user', content: m.content };
      }
    });
  }

  private async saveMessage(conversationId: string, m: {
    role: 'user' | 'assistant' | 'tool' | 'notice'; content: string; toolCalls?: unknown; metaResponseId?: string;
  }): Promise<void> {
    await this.db.insert(messages).values({ conversationId, ...m });
  }

  /** Service Store catalog with the user's activations, for the turn context (B3). */
  private async servicesFor(userId: string, accountKind?: string) {
    const rows = await this.db.select({ slug: connectors.slug, type: connectors.type, name: connectors.name, capabilities: connectors.capabilities, active: userServices.id })
      .from(connectors).leftJoin(userServices, and(eq(userServices.connectorId, connectors.id), eq(userServices.userId, userId)))
      .where(eq(connectors.live, true)).orderBy(asc(connectors.sortOrder), asc(connectors.name)); // the Store's order
    return rows.filter((r) => connectorVisibleTo(r, accountKind)).map((r) => ({ name: r.name, capabilities: r.capabilities as string[], active: Boolean(r.active) }));
  }

  private async loadIperson(ipersonId: string) {
    const [row] = await this.db.select({ iperson: ipersons, user: users }).from(ipersons)
      .innerJoin(users, eq(users.id, ipersons.userId)).where(eq(ipersons.id, ipersonId));
    if (!row) throw new Error(`i-person ${ipersonId} not found`);
    return row;
  }

  private async toolContext(ipersonId: string): Promise<ToolContext> {
    const { user } = await this.loadIperson(ipersonId);
    return { db: this.db, llm: this.llm, ipersonId, userName: user.name, timezone: user.timezone, now: this.now(), demo: isDemoAccount(user.accountKind) };
  }
}

/** DEMO: a short outcome for the calls panel ("→ saved to the calendar", "→ kept in the outbox"). */
function resultNote(result: unknown): string {
  const r = (result ?? {}) as { outbox?: boolean; delivered?: boolean; error?: string; event_id?: string };
  if (r.error) return ` (${clip(r.error, 60)})`;
  if (r.outbox) return ' → kept in the outbox (simulated: not sent)';
  if (r.delivered) return ' → sent';
  return '';
}
