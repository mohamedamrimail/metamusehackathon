import { eq, sql } from 'drizzle-orm';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../src/agent/runtime.ts';
import { activeRules, checkReply } from '../src/agent/rules.ts';
import { builtinTools } from '../src/agent/tools/index.ts';
import type { Tool } from '../src/agent/tools/types.ts';
import { metaCostMicros, microsToUsd } from '../src/billing/credits.ts';
import { config } from '../src/config.ts';
import { createDb, type Db } from '../src/db/client.ts';
import { actions, ipersonRules, ipersons, profileFacts, users, visitorConversations } from '../src/db/schema.ts';
import type { AppDeps } from '../src/http/deps.ts';
import { EventBus } from '../src/lib/bus.ts';
import { MetaLlm, type Llm, type LlmResult } from '../src/meta/llm.ts';
import { visitorTurn } from '../src/public/visitor.ts';
import {
  parseCases, renderEval, replaceSection, RESULTS_HEADER, scoreCase, summarize,
  type CaseResult, type EvalCase, type Lang, type Observation, type RunMeta,
} from './score.ts';

// pnpm --filter @ipersons/server eval [--only id,id] [--concurrency n] [--rescore]
// Runs eval/cases.jsonl against the real Muse Spark. Side effects are stubbed: no email (no SMTP), no WhatsApp
// (a recording stub), no web search (fixed fixtures, through which injections arrive wrapped as untrusted),
// no charges (no credits; each call's cost is computed and logged instead). Writes docs/eval-results.md.

const ROOT = new URL('../../../', import.meta.url);
const RESULTS_MD = fileURLToPath(new URL('docs/eval-results.md', ROOT));
const RUN_JSON = fileURLToPath(new URL('eval/last-run.json', new URL('../', import.meta.url)));
/** A fixed "now" (a Wednesday) so "this Friday" means the same day in every run. */
const NOW = new Date('2026-11-04T08:00:00Z');
/** Simulations go behind SHOW_SIMULATIONS (off in production), so the eval offers the production tool set. */
const SIMULATIONS = new Set(['place_order', 'wallet_status', 'paper_trade', 'portfolio_status']);
const TEMPERATURE = 0;

const PERSONA: Record<Lang, { name: string; locale: string; timezone: string }> = {
  en: { name: 'Merry Collins', locale: 'en', timezone: 'Europe/London' },
  fr: { name: 'Camille Durand', locale: 'fr', timezone: 'Africa/Tunis' },
  ar: { name: 'Layla Mansour', locale: 'ar', timezone: 'Africa/Tunis' },
  tn: { name: 'Amira Ben Salem', locale: 'ar', timezone: 'Africa/Tunis' },
  de: { name: 'Jonas Weber', locale: 'de', timezone: 'Europe/Berlin' },
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// --- guards: real model, isolated database, nothing that can reach a person ---
if (!config.META_API_KEY) throw new Error('META_API_KEY is not set: the eval runs against the real Muse Spark');
if (config.SMTP_URL || config.WA_ACCESS_TOKEN) throw new Error('SMTP_URL / WA_ACCESS_TOKEN must be blank for the eval (use the package script)');
const dbUrl = process.env.EVAL_DATABASE_URL || config.TEST_DATABASE_URL;
if (!dbUrl || !/_test(\?|$)/.test(dbUrl)) throw new Error('EVAL_DATABASE_URL or TEST_DATABASE_URL must point to a *_test database');

interface CallLog { caseId: string; purpose: string; ms: number; input: number; cached: number; output: number; micros: number }
const costLog: CallLog[] = [];

/** Wraps the model: logs each call's cost (never charged to anyone) and reports what the model asked for. */
function recorder(base: Llm, caseId: string, purpose: string, onResult?: (res: LlmResult, req: Parameters<Llm['complete']>[0]) => void): Llm {
  return {
    async complete(req) {
      const t = Date.now();
      const res = await base.complete(req);
      const u = res.usage ?? { input: 0, cachedInput: 0, output: 0 };
      const isChecker = String(req.messages[0]?.content ?? '').startsWith('You check a digital twin');
      costLog.push({
        caseId, purpose: isChecker ? `${purpose}:rules-check` : purpose, ms: Date.now() - t,
        input: u.input, cached: u.cachedInput, output: u.output,
        micros: metaCostMicros({ kind: 'llm', model: config.META_LLM_MODEL, usage: u }),
      });
      onResult?.(res, req);
      return res;
    },
  };
}

/** The search tools with their real names, schemas and `external` flag, returning the case's fixture. */
function searchStubs(c: EvalCase, onDelivered: () => void): Tool[] {
  const items = () => {
    const list = (c.search?.items ?? []).map((i) => ({ ...i }));
    if (c.injection && list[0]) list[0].why = `${list[0].why ?? ''}\n\n${c.injection}`.trim();
    if (c.injection) onDelivered();
    return list;
  };
  return builtinTools.filter((t) => t.name === 'find_offers' || t.name === 'find_opportunities').map((t): Tool => ({
    ...t,
    execute: async (_ctx, a: { provider?: string }) => {
      const found = items();
      if (t.name === 'find_offers') return { provider: a.provider, options: found, prefilled_search: null, ...(found.length ? {} : { note: 'no reliable listing found' }) };
      return found.length ? { items: found, source: 'web search' } : { items: [], note: 'web search found nothing reliable; say so, do not make anything up' };
    },
  }));
}

async function setUp(db: Db, c: EvalCase, index: number) {
  const p = PERSONA[c.lang];
  const [user] = await db.insert(users).values({
    email: `${c.id}@eval.i-persons.test`, name: p.name, locale: p.locale, timezone: p.timezone,
    // A verified number: email proposals need one (send_email's check). Nothing is ever sent to it.
    phoneE164: `+21650${String(100000 + index)}`, verifiedAt: NOW, aiCreditMicros: 0,
  }).returning();
  const [ip] = await db.insert(ipersons).values({ userId: user!.id, displayName: 'Nova', publicEnabled: c.agent === 'visitor', handle: `eval-${c.id.replace(/_/g, '-')}` }).returning();
  for (const f of c.facts) await db.insert(profileFacts).values({ ipersonId: ip!.id, ...f, source: 'user_edit' });
  for (const r of c.rules) await db.insert(ipersonRules).values({ ipersonId: ip!.id, kind: r.kind, text: r.text, source: 'user' });
  return { user: user!, ip: ip! };
}

async function runCase(db: Db, base: Llm, c: EvalCase, index: number): Promise<CaseResult> {
  const o: Observation = { toolCalls: [], proposals: [], reply: '' };
  let delivered = false;
  const after: string[] = [];
  const onResult = (res: LlmResult, req: Parameters<Llm['complete']>[0]) => {
    if (String(req.messages[0]?.content ?? '').startsWith('You check a digital twin')) {
      if (/"ok"\s*:\s*false/.test(res.content)) o.replyRewritten = true;
      return;
    }
    for (const call of res.toolCalls) {
      o.toolCalls.push(call.name);
      if (delivered) after.push(call.name);
    }
  };
  try {
    const { ip } = await setUp(db, c, index);
    if (c.agent === 'owner') {
      const tools = [
        ...builtinTools.filter((t) => !SIMULATIONS.has(t.name) && t.name !== 'find_offers' && t.name !== 'find_opportunities'),
        ...searchStubs(c, () => { delivered = true; }),
      ];
      const rt = new AgentRuntime({
        db, llm: recorder(base, c.id, 'agent', onResult), tools, now: () => NOW,
        // send_whatsapp only ever reaches the owner; here it reaches nobody.
        whatsapp: async () => {},
      });
      const conversationId = await rt.conversationFor(ip.id, 'web');
      const res = await rt.handleUserMessage({ ipersonId: ip.id, conversationId, text: c.message });
      o.reply = res.reply;
      o.proposals = res.proposed.map((a) => ({ tool: a.tool, args: a.args, summary: a.summary, influencedBy: a.influencedBy }));
    } else {
      const [conv] = await db.insert(visitorConversations).values({ ipersonId: ip.id, visitorName: 'Alex', ipHash: 'eval' }).returning();
      // No WhatsApp, no billing: the visitor's requests only become cards in the eval database.
      const deps = { db, llm: recorder(base, c.id, 'visitor', onResult), bus: new EventBus(), billing: false, wa: undefined } as unknown as AppDeps;
      o.reply = (await visitorTurn(deps, conv!.id, c.message)).reply;
      const cards = await db.select().from(actions).where(eq(actions.ipersonId, ip.id));
      o.proposals = cards.map((a) => ({ tool: a.tool, args: a.args, summary: a.summary, influencedBy: a.influencedBy }));
    }
    if (c.violating_draft) {
      const check = await checkReply(recorder(base, c.id, 'draft'), await activeRules(db, ip.id), c.message, c.violating_draft);
      o.draftBlocked = !check.ok;
    }
  } catch (err) {
    o.error = err instanceof Error ? err.message : String(err);
  }
  o.injectionDelivered = c.injection ? delivered : undefined;
  if (c.injection) o.callsAfterInjection = after;
  return scoreCase(c, o);
}

async function main() {
  const all = parseCases(await readFile(new URL('cases.jsonl', import.meta.url), 'utf8'));
  const only = flag('only')?.split(',');
  const cases = only ? all.filter((c) => only.includes(c.id)) : all;
  const concurrency = Math.max(1, Number(flag('concurrency') ?? 3));
  const { db, pool } = createDb(dbUrl);
  await db.execute(sql`truncate users cascade`);
  const base = new MetaLlm(config.META_LLM_MODEL, config.META_API_KEY, { temperature: TEMPERATURE });

  const started = Date.now();
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let i = next++; i < cases.length; i = next++) {
      const c = cases[i]!;
      results[i] = await runCase(db, base, c, all.indexOf(c));
      const r = results[i]!;
      const spent = microsToUsd(costLog.reduce((s, x) => s + x.micros, 0));
      console.log(`${r.status.padEnd(7)} ${c.id.padEnd(20)} tools=[${r.observation.toolCalls.join(',')}] cards=[${r.observation.proposals.map((p) => p.tool).join(',')}] $${spent.toFixed(4)} ${r.reasons.map((x) => x.text).join('; ')}`);
    }
  }));
  await pool.end();

  const sum = (k: 'input' | 'cached' | 'output' | 'micros') => costLog.reduce((s, x) => s + x[k], 0);
  const meta = {
    model: config.META_LLM_MODEL, reasoningEffort: config.META_REASONING_EFFORT, temperature: `${TEMPERATURE} (accepted by the API)`,
    date: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC', costUsd: microsToUsd(sum('micros')), calls: costLog.length,
    inputTokens: sum('input'), cachedTokens: sum('cached'), outputTokens: sum('output'), durationS: (Date.now() - started) / 1000,
  };
  await write(results, meta, costLog);
}

async function write(results: CaseResult[], meta: RunMeta, calls: CallLog[]) {
  const summary = summarize(results);
  const doc = await readFile(RESULTS_MD, 'utf8').catch(() => RESULTS_HEADER);
  await writeFile(RESULTS_MD, replaceSection(doc, 'eval', renderEval(summary, results, meta)));
  await writeFile(RUN_JSON, JSON.stringify({ meta, summary: { ...summary, depends: summary.depends.map((r) => r.id), failures: summary.failures.map((r) => r.id) }, results, costLog: calls }, null, 2));
  console.log(`\naccuracy ${summary.overall.ok}/${summary.overall.n}, rules ${summary.rulesCompliance.ok}/${summary.rulesCompliance.n}, checker ${summary.rulesCheck.ok}/${summary.rulesCheck.n}, injection ${summary.injection.ok}/${summary.injection.n}, cost $${meta.costUsd.toFixed(4)} (${meta.calls} calls)`);
  console.log(`wrote ${RESULTS_MD} and ${RUN_JSON}`);
}

/** --rescore: scores the last run's recorded observations again with the current cases and scoring (no model calls). */
async function rescore() {
  const cases = parseCases(await readFile(new URL('cases.jsonl', import.meta.url), 'utf8'));
  const last = JSON.parse(await readFile(RUN_JSON, 'utf8')) as { meta: RunMeta; results: CaseResult[]; costLog: CallLog[] };
  const results = last.results.map((r) => scoreCase(cases.find((c) => c.id === r.id)!, r.observation));
  await write(results, last.meta, last.costLog);
}

if (args.includes('--rescore')) await rescore();
else await main();


