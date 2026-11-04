import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { profileLinks } from '../db/schema.ts';
import { assertPublicUrl } from '../mcp/client.ts';
import type { Llm } from '../meta/llm.ts';
import { FACT_CATEGORIES, upsertFact } from './memory.ts';
import { UNTRUSTED_RULE, wrapUntrusted } from './untrusted.ts';

// "Know more about you": the user's own website or portfolio (one public page, robots.txt respected) and
// their LinkedIn text or PDF, which they paste or upload themselves: social networks are never fetched.
// The text goes to the model as untrusted data, and what it learns becomes private facts the user can edit.

export const USER_AGENT = 'Mozilla/5.0 (compatible; i-persons/1; +https://i-persons.com)';
const ROBOTS_AGENT = 'i-persons';

/** Whether robots.txt lets us read `path`: the rules for "i-persons" if there are any, else for "*". */
export function robotsAllow(robots: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^(user-agent|allow|disallow)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const [, field, value] = m;
    if (field!.toLowerCase() === 'user-agent') {
      if (!lastWasAgent || !current) groups.push(current = { agents: [], rules: [] });
      current.agents.push(value!.toLowerCase());
      lastWasAgent = true;
    } else if (current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: field!.toLowerCase() === 'allow', path: value });
    }
  }
  const group = groups.find((g) => g.agents.some((a) => a === ROBOTS_AGENT)) ?? groups.find((g) => g.agents.includes('*'));
  // The longest matching rule wins (Allow on a tie), as robots.txt is read by the big crawlers.
  const match = group?.rules.filter((r) => path.startsWith(r.path.replace(/\*.*$/, ''))).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow))[0];
  return !match || match.allow;
}

async function allowedByRobots(url: URL): Promise<boolean> {
  const res = await fetch(new URL('/robots.txt', url), { redirect: 'follow', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': USER_AGENT } }).catch(() => undefined);
  if (!res?.ok) return true; // no robots.txt: allowed
  return robotsAllow((await res.text()).slice(0, 100_000), url.pathname || '/');
}

/** Visible text and meta description of a public page, trimmed for the model. */
export function pageText(html: string): string {
  const meta = [...html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:title|og:description)["'][^>]*content=["']([^"']*)["']/gi)]
    .map((m) => m[1]).join('\n');
  const body = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
  return `${meta}\n${body}`.trim().slice(0, 6000);
}

/** One public page of the user's own site: SSRF-guarded, robots.txt respected, a clear user agent. */
async function fetchPage(url: string): Promise<string> {
  const target = await assertPublicUrl(url);
  if (!(await allowedByRobots(target))) throw Object.assign(new Error('robots'), { robots: true });
  const res = await fetch(url, {
    redirect: 'follow', signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });
  if (!res.ok) return '';
  const html = (await res.text()).slice(0, 500_000);
  return pageText(html);
}

/** A picture WhatsApp accepts (JPEG/PNG, ≤ 5 MB). */
export interface WaImage { data: Buffer; mime: 'image/jpeg' | 'image/png' }
const MAX_IMAGE = 5_000_000;

/** The page's preview picture (og:image / twitter:image), resolved against the page address. */
export function previewImage(html: string, pageUrl: string): string | undefined {
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return undefined;
  try { return new URL(m[1]!.replace(/&amp;/g, '&'), pageUrl).toString(); } catch { return undefined; }
}

/**
 * A picture for a suggestion: a direct image link, or a page whose preview image is used.
 * Returns undefined when there's no usable picture (the message then goes as text only).
 */
export async function imageFrom(url: string, depth = 0): Promise<WaImage | undefined> {
  await assertPublicUrl(url);
  const res = await fetch(url, {
    redirect: 'follow', signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; i-persons/1; +https://i-persons.com)', Accept: 'image/jpeg,image/png,text/html;q=0.8' },
  });
  if (!res.ok) return undefined;
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'image/jpeg' || type === 'image/png') {
    if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE) return undefined;
    const data = Buffer.from(await res.arrayBuffer());
    return data.length > 0 && data.length <= MAX_IMAGE ? { data, mime: type } : undefined;
  }
  if (type !== 'text/html' || depth > 0) return undefined;
  const preview = previewImage((await res.text()).slice(0, 500_000), res.url || url);
  return preview ? imageFrom(preview, 1) : undefined;
}

const Learned = z.object({
  summary: z.string().max(300),
  facts: z.array(z.object({ category: z.enum(FACT_CATEGORIES), key: z.string().min(1).max(60), value: z.string().min(1).max(300) })).max(8),
});

/** Lasting facts from text about the user (their page, or LinkedIn text they pasted). Returns a one-line summary. */
export async function learnFromText(db: Db, llm: Llm, ipersonId: string, text: string, opts: { label: string; pendingFrom?: string }): Promise<{ summary: string; facts: number }> {
  const res = await llm.complete({
    tools: [],
    messages: [
      {
        role: 'system',
        content: `This text is about the user (they gave it to us). Learn lasting facts about them: job, skills, experience, city, interests, goals. ${UNTRUSTED_RULE} `
          + 'Reply with JSON only: {"summary":"one sentence","facts":[{"category":"preference|routine|goal|constraint|contact","key":"snake_case","value":"…"}]} (max 8).',
      },
      { role: 'user', content: wrapUntrusted(opts.label, text.slice(0, 12_000)) },
    ],
  });
  const json = /\{[\s\S]*\}/.exec(res.content)?.[0];
  const parsed = json ? Learned.safeParse(JSON.parse(json)) : undefined;
  if (!parsed?.success) throw new Error('nothing usable');
  for (const f of parsed.data.facts) await upsertFact(db, ipersonId, { ...f, source: 'link', confidence: 0.6, pendingFrom: opts.pendingFrom });
  return { summary: parsed.data.summary, facts: parsed.data.facts.length };
}

export async function readLink(db: Db, llm: Llm, ipersonId: string, link: { id: string; kind: string; url: string }): Promise<void> {
  try {
    const text = await fetchPage(link.url);
    if (text.length < 40) {
      await db.update(profileLinks).set({ status: 'private', readAt: new Date() }).where(eq(profileLinks.id, link.id));
      return;
    }
    // A fetched page is outside content even when it's the user's: what it teaches waits for their keep.
    const { summary } = await learnFromText(db, llm, ipersonId, text, { label: `${link.kind} page ${link.url}`, pendingFrom: `your ${link.kind} page` });
    await db.update(profileLinks).set({ status: 'read', summary, readAt: new Date() }).where(eq(profileLinks.id, link.id));
  } catch (err) {
    await db.update(profileLinks).set({ status: (err as { robots?: boolean }).robots ? 'private' : 'failed', readAt: new Date() }).where(eq(profileLinks.id, link.id));
  }
}

/** Text of a PDF (LinkedIn's "Save to PDF"), via poppler's pdftotext. */
export async function pdfText(pdf: Buffer): Promise<string> {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'ip-pdf-'));
  try {
    await writeFile(join(dir, 'in.pdf'), pdf);
    return await new Promise<string>((resolve, reject) => execFile('pdftotext', ['-q', '-enc', 'UTF-8', join(dir, 'in.pdf'), '-'], { timeout: 15_000, maxBuffer: 2_000_000 },
      (err, out) => (err ? reject(err) : resolve(String(out).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
