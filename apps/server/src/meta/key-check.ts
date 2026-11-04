import { config } from '../config.ts';

// Startup check of META_API_KEY: one GET /models on the Meta Model API. A missing or rejected key keeps the app
// running in demo mode (the rule-based stand-in in meta/demo-llm.ts) with a warning banner on every page.

export type MetaKeyStatus = 'ok' | 'missing' | 'invalid' | 'unreachable';

export interface MetaKeyCheck {
  status: MetaKeyStatus;
  message: string;
  /** Models the key can use (when the check got that far). */
  models?: string[];
}

let last: MetaKeyCheck = { status: config.META_API_KEY ? 'unreachable' : 'missing', message: 'Not checked yet.' };
/** The result of the last startup check (the web banner reads it through GET /features). */
export const metaKeyCheck = (): MetaKeyCheck => last;

export async function checkMetaKey(fetchImpl: typeof fetch = fetch): Promise<MetaKeyCheck> {
  if (!config.META_API_KEY) {
    last = { status: 'missing', message: 'META_API_KEY is not set. Add your Meta Model API key to .env and restart. Running in demo mode.' };
    return last;
  }
  try {
    const res = await fetchImpl(`${config.META_BASE_URL.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${config.META_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      last = { status: 'invalid', message: `META_API_KEY was rejected by ${config.META_BASE_URL} (HTTP ${res.status}). Check the key in .env and restart. Running in demo mode.` };
      return last;
    }
    if (!res.ok) {
      last = { status: 'unreachable', message: `The Meta Model API answered HTTP ${res.status} to the key check; carrying on with the key.` };
      return last;
    }
    const models = (((await res.json()) as { data?: { id: string }[] }).data ?? []).map((m) => m.id).sort();
    const missing = [config.META_LLM_MODEL, config.META_SAM_MODEL].filter((m) => !models.includes(m));
    last = {
      status: 'ok',
      models,
      message: missing.length
        ? `META_API_KEY OK, but these models are not listed for it: ${missing.join(', ')}.`
        : `META_API_KEY OK: ${config.META_LLM_MODEL} and ${config.META_SAM_MODEL} are available.`,
    };
    return last;
  } catch (err) {
    last = { status: 'unreachable', message: `Could not reach ${config.META_BASE_URL} to check META_API_KEY (${(err as Error).message}); carrying on with the key.` };
    return last;
  }
}

/** A boxed message for the server log, easy to spot in `docker compose up` output. */
export function keyBanner(c: MetaKeyCheck): string {
  const title = c.status === 'ok' ? 'Meta Model API: OK' : c.status === 'unreachable' ? 'Meta Model API: could not check the key' : 'Meta Model API: DEMO MODE';
  const lines = [title, '', ...wrap(c.message, 72)];
  const w = Math.max(...lines.map((l) => l.length));
  const bar = '='.repeat(w + 4);
  return ['', bar, ...lines.map((l) => `| ${l.padEnd(w)} |`), bar, ''].join('\n');
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if ((line + ' ' + word).trim().length > width) { out.push(line.trim()); line = word; } else line += ' ' + word;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}
