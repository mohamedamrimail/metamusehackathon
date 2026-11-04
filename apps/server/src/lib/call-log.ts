import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { ipersons, users } from '../db/schema.ts';
import type { Llm, LlmResult } from '../meta/llm.ts';
import { runtimeSettings } from './settings.ts';

// DEMO: the "Meta AI calls" panel. Every live Meta model call (Muse Spark, Muse Voice Transcribe, Muse Image, SAM 3.1)
// and the steps of the features around them (approval gate, twin-to-twin, WhatsApp, email…) are logged here with their
// latency, but only for demo accounts and only while the runtime setting showCallsPanel is on. Demo viewers read the
// log live (GET /demo/calls, server-sent events). Who a call belongs to rides along in AsyncLocalStorage.

export type CallService =
  | 'Muse Spark' | 'Muse Voice Transcribe' | 'Muse Image' | 'SAM 3.1'
  | 'WhatsApp' | 'Approval gate' | 'Rules' | 'Twin-to-twin' | 'Calendar' | 'Email' | 'Memory' | 'Tool' | 'Glasses';

export const META_SERVICES: ReadonlySet<CallService> = new Set(['Muse Spark', 'Muse Voice Transcribe', 'Muse Image', 'SAM 3.1']);

export interface CallEntry {
  id: number;
  at: string;
  service: CallService;
  /** True for Meta model calls (the rest are the app's own steps and channels). */
  meta: boolean;
  what: string;
  ms?: number;
  /** Not really sent: no API key / channel not configured / a fictional demo number. */
  simulated?: string;
  ok: boolean;
  /** The twin it ran for, e.g. "i-Sara". */
  twin?: string;
}

interface CallCtx { userId?: string; purpose?: string }

const als = new AsyncLocalStorage<CallCtx>();
const bus = new EventEmitter();
bus.setMaxListeners(200);
const recent: CallEntry[] = [];
const MAX = 200;
let seq = 0;
let db: Db | undefined;

export const setCallLogDb = (d: Db) => { db = d; };
export const callContext = (): CallCtx | undefined => als.getStore();

/** Runs fn with this user (and purpose) as the owner of every call made inside it. */
export function withCall<T>(ctx: CallCtx, fn: () => T): T {
  const outer = als.getStore();
  return als.run({ ...outer, ...ctx, purpose: ctx.purpose ?? outer?.purpose }, fn);
}

/** A purpose for the calls inside fn, keeping the current owner ("Rules check", "Twin-to-twin plan"…). */
export function withPurpose<T>(purpose: string, fn: () => T): T {
  return als.run({ ...als.getStore(), purpose }, fn);
}

/** The same model, with every call owned by `ctx.userId` (an inner withPurpose still names the purpose). */
export function tagLlm(llm: Llm, ctx: CallCtx): Llm {
  const run = <T>(fn: () => Promise<T>) => {
    const outer = als.getStore();
    return als.run({ ...outer, userId: ctx.userId ?? outer?.userId, purpose: outer?.purpose ?? ctx.purpose }, fn);
  };
  const search = llm.search?.bind(llm);
  return {
    complete: (req) => run(() => llm.complete(req)),
    ...(search && { search: (req) => run(() => search(req)) }),
  };
}

const people = new Map<string, { at: number; demo: boolean; twin?: string }>();
async function personOf(userId: string) {
  const hit = people.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  if (!db) return undefined;
  const [u] = await db.select({ kind: users.accountKind, twin: ipersons.displayName }).from(users)
    .leftJoin(ipersons, eq(ipersons.userId, users.id)).where(eq(users.id, userId)).limit(1);
  const p = { at: Date.now(), demo: u?.kind === 'demo', twin: u?.twin ?? undefined };
  people.set(userId, p);
  return p;
}

/** Logs one call for the owner in `ctx` (default: the current context). Never throws, never slows the caller much. */
export async function logCall(e: Omit<CallEntry, 'id' | 'at' | 'meta' | 'ok'> & { ok?: boolean }, ctx: CallCtx | undefined = als.getStore()): Promise<void> {
  try {
    if (!ctx?.userId || !db) return;
    const who = await personOf(ctx.userId);
    if (!who?.demo || !(await runtimeSettings(db)).showCallsPanel) return;
    const what = ctx.purpose && META_SERVICES.has(e.service) ? `${ctx.purpose}: ${e.what}` : e.what;
    const entry: CallEntry = { ...e, what: clip(what, 160), ok: e.ok ?? true, id: ++seq, at: new Date().toISOString(), meta: META_SERVICES.has(e.service), twin: who.twin };
    recent.push(entry);
    if (recent.length > MAX) recent.shift();
    bus.emit('call', entry);
  } catch { /* the panel never breaks a call */ }
}

export const recentCalls = (limit = 60): CallEntry[] => recent.slice(-limit);
/** The panel's Clear button: forget what was logged so far (new calls keep coming). */
export const clearCalls = () => { recent.length = 0; };
export function onCall(fn: (e: CallEntry) => void): () => void {
  bus.on('call', fn);
  return () => bus.off('call', fn);
}

/** Times fn and logs it as a Meta model call (also when it fails). */
export async function timedMeta<T>(service: CallService, what: string | ((r: T) => string), fn: () => Promise<T>, simulated?: string): Promise<T> {
  const t0 = performance.now();
  try {
    const r = await fn();
    void logCall({ service, what: typeof what === 'string' ? what : what(r), ms: Math.round(performance.now() - t0), simulated });
    return r;
  } catch (err) {
    void logCall({ service, what: `${typeof what === 'string' ? what : 'call'} failed: ${(err as Error).message}`, ms: Math.round(performance.now() - t0), ok: false, simulated });
    throw err;
  }
}

/** Muse Spark calls of the given model, logged with what came back (tool choice or reply) and the tokens. */
export function loggedLlm(llm: Llm, simulated?: string): Llm {
  const search = llm.search?.bind(llm);
  return {
    complete: (req) => timedMeta('Muse Spark', (r: LlmResult) => describe(r), () => llm.complete(req), simulated),
    ...(search && {
      search: (req) => timedMeta('Muse Spark', (r) => `web search "${clip(req.input, 50)}" → ${r.sources.length} sources`, () => search(req), simulated),
    }),
  };
}

function describe(r: LlmResult): string {
  const tokens = r.usage ? ` (${fmtTokens(r.usage.input)} in / ${fmtTokens(r.usage.output)} out)` : '';
  if (r.toolCalls.length) return `chose ${r.toolCalls.map((c) => c.name).join(', ')}${tokens}`;
  const text = r.content.replace(/^\[mood:[a-z]+\]\s*/i, '').trim();
  // Checks answer in JSON ({"ok":true} / {"verdict":"blocked",…}): shown as a verdict.
  if (text.startsWith('{')) {
    try {
      const v = JSON.parse(text) as { ok?: boolean; verdict?: string };
      return `verdict ${v.verdict ?? (v.ok === false ? 'not OK' : 'OK')}${tokens}`;
    } catch { /* not JSON after all */ }
  }
  return `wrote "${clip(text, 70)}"${tokens}`;
}
const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Tests: forget the log and the account cache. */
export function resetCallLog() { recent.length = 0; people.clear(); }
