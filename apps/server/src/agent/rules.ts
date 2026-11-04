import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { ipersonRules, sourcePrefs } from '../db/schema.ts';
import type { Llm } from '../meta/llm.ts';
import { providerById } from '@ipersons/shared';

// The twin's do / don't list. The agent sees it every turn, and a separate checker call reviews each
// final reply against it before anyone sees or hears it (the "control agent").

export type Rule = Pick<typeof ipersonRules.$inferSelect, 'id' | 'kind' | 'text'>;

export async function activeRules(db: Db, ipersonId: string): Promise<Rule[]> {
  return db.select({ id: ipersonRules.id, kind: ipersonRules.kind, text: ipersonRules.text }).from(ipersonRules)
    .where(and(eq(ipersonRules.ipersonId, ipersonId), eq(ipersonRules.active, true), eq(ipersonRules.status, 'active'))).orderBy(asc(ipersonRules.createdAt));
}

export const formatRules = (rules: Rule[]) =>
  rules.map((r, i) => `${i + 1}. ${r.kind === 'do' ? 'DO' : 'DON’T'}: ${r.text}`).join('\n');

export interface RuleCheck { ok: boolean; reply: string; violated: string[] }

/**
 * Reviews `reply` against the rules; on a violation returns a corrected reply. Fails open (keeps the
 * reply) if the checker errs or answers nonsense: the approval gate, not this check, guards actions.
 */
export async function checkReply(llm: Llm, rules: Rule[], userText: string, reply: string): Promise<RuleCheck> {
  if (!rules.length || !reply.trim()) return { ok: true, reply, violated: [] };
  try {
    const res = await llm.complete({
      tools: [],
      messages: [
        {
          role: 'system',
          content: 'You check a digital twin’s reply against its owner’s rules. Only flag a clear violation. '
            + 'Reply with JSON only: {"ok":true} or {"ok":false,"violated":[rule numbers],"rewrite":"the corrected reply, same language and tone, keep any [mood:x] tag"}.',
        },
        { role: 'user', content: `Rules:\n${formatRules(rules)}\n\nThe user said:\n${userText.slice(0, 1500)}\n\nThe twin’s reply:\n${reply}` },
      ],
    });
    const json = /\{[\s\S]*\}/.exec(res.content)?.[0];
    const verdict = json ? JSON.parse(json) as { ok?: boolean; violated?: number[]; rewrite?: string } : null;
    if (!verdict || verdict.ok !== false || !verdict.rewrite?.trim()) return { ok: true, reply, violated: [] };
    const violated = (verdict.violated ?? []).map((n) => rules[n - 1]?.id).filter((x): x is string => Boolean(x));
    return { ok: false, reply: verdict.rewrite.trim(), violated };
  } catch {
    return { ok: true, reply, violated: [] };
  }
}

export type ActionCheck = { verdict: 'ok' } | { verdict: 'blocked'; rules: Rule[] } | { verdict: 'unavailable' };

/** How long a proposal waits for the rules check before it is held for an explicit tap. */
export const ACTION_CHECK_TIMEOUT_MS = 8000;

/**
 * Checks a write/money proposal against the rules before its card is shown. Unlike replies this fails
 * closed: if the checker errs, times out or answers nonsense, the verdict is 'unavailable' and the card
 * is held for an explicit tap.
 */
export async function checkAction(llm: Llm, rules: Rule[], proposal: { tool: string; args: unknown; summary: string }, timeoutMs = ACTION_CHECK_TIMEOUT_MS): Promise<ActionCheck> {
  if (!rules.length) return { verdict: 'ok' };
  try {
    const res = await Promise.race([
      llm.complete({
        tools: [],
        messages: [
          {
            role: 'system',
            content: 'You check an action a digital twin wants to take for its owner against the owner’s rules. Flag it only if doing it would clearly break a rule. '
              + 'Reply with JSON only: {"ok":true} or {"ok":false,"violated":[rule numbers]}.',
          },
          { role: 'user', content: `Rules:\n${formatRules(rules)}\n\nProposed action: ${proposal.summary}\nTool: ${proposal.tool}\nArguments: ${JSON.stringify(proposal.args).slice(0, 2000)}` },
        ],
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('rules check timed out')), timeoutMs)),
    ]);
    const json = /\{[\s\S]*\}/.exec(res.content)?.[0];
    const verdict = json ? JSON.parse(json) as { ok?: unknown; violated?: unknown } : null;
    if (verdict?.ok === true) return { verdict: 'ok' };
    if (verdict?.ok === false && Array.isArray(verdict.violated)) {
      const broken = verdict.violated.map((n) => rules[Number(n) - 1]).filter((r): r is Rule => Boolean(r));
      if (broken.length) return { verdict: 'blocked', rules: broken };
    }
    return { verdict: 'unavailable' };
  } catch {
    return { verdict: 'unavailable' };
  }
}

export async function countHits(db: Db, ruleIds: string[]) {
  if (ruleIds.length) await db.update(ipersonRules).set({ hits: sql`${ipersonRules.hits} + 1` }).where(inArray(ipersonRules.id, ruleIds));
}

/** "travel: Booking.com (booking.com) > Skyscanner (skyscanner.net)", per category, best first. */
export async function preferredSources(db: Db, ipersonId: string): Promise<Record<string, { name: string; site: string }[]>> {
  const rows = await db.select().from(sourcePrefs).where(eq(sourcePrefs.ipersonId, ipersonId)).orderBy(asc(sourcePrefs.rank));
  const out: Record<string, { name: string; site: string }[]> = {};
  for (const r of rows) {
    const p = providerById(r.provider);
    if (p) (out[r.category] ??= []).push({ name: p.name, site: p.site });
  }
  return out;
}
