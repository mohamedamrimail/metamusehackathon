import { z } from 'zod';
import { listFacts } from '../memory.ts';
import { preferredSources } from '../rules.ts';
import { defineTool } from './types.ts';

const Items = z.object({
  items: z.array(z.object({
    title: z.string(), why: z.string().optional(), price: z.string().optional(), when: z.string().optional(), url: z.string().optional(),
  })).max(5),
});
type Item = z.infer<typeof Items>['items'][number];

const FORMAT = 'Reply with JSON only: {"items":[{"title","why","price","when","url"}]} (max 5).';

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
};

/** Free hosting where lookalike sites live (e.g. a fake "Al Jazeera" on pages.dev): never a source. */
const FREE_HOSTING = /\.(pages\.dev|vercel\.app|netlify\.app|github\.io|web\.app|firebaseapp\.com|glitch\.me|blogspot\.com|wordpress\.com|wixsite\.com|weebly\.com|framer\.website|webflow\.io)$/i;

/** A specific page, not a site's home page (a bare domain proves nothing about the item). */
const isPage = (url: string) => {
  try { return new URL(url).pathname.replace(/\/+$/, '') !== ''; } catch { return false; }
};

/** Only items linking to a page on a site the search really returned (no invented listings or URLs), never free hosting. */
export function keepSourced(items: Item[], sources: string[]): Item[] {
  const hosts = new Set(sources.map(hostOf).filter(Boolean));
  return items.filter((i) => {
    const host = i.url ? hostOf(i.url) : undefined;
    return Boolean(host && hosts.has(host) && !FREE_HOSTING.test(host) && isPage(i.url!));
  });
}

/** "Africa/Tunis" → "Tunis": where to look when the user hasn't said. */
export const cityFromTimezone = (tz: string) => tz.split('/').at(-1)?.replace(/_/g, ' ');

export default defineTool({
  name: 'find_opportunities',
  description: 'Search the web for real, current things matching the user: travel deals, jobs, classes, deals, or the latest news on a topic. Returns up to 5, each with a source link.',
  risk: 'read',
  external: 'web search',
  schema: z.object({
    kind: z.enum(['travel', 'job', 'class', 'deal', 'news']),
    query: z.string().min(1).max(300),
    constraints: z.string().max(500).optional(),
    near: z.string().max(100).optional().describe('City or area to search in, if the user named one'),
  }),
  async execute(ctx, a) {
    const facts = await listFacts(ctx.db, ctx.ipersonId, { limit: 30 });
    const near = a.near ?? cityFromTimezone(ctx.timezone);
    const category = { travel: 'travel', job: 'jobs', class: 'education', deal: 'shopping', news: 'news' }[a.kind];
    const preferred = (await preferredSources(ctx.db, ctx.ipersonId))[category] ?? [];
    const input = `Kind: ${a.kind}\nQuery: ${a.query}\nConstraints: ${a.constraints ?? 'none'}\n`
      + `${near ? `Near: ${near} (search there; ignore results from other countries)\n` : ''}`
      + `${preferred.length ? `Preferred sites, best first (search these first): ${preferred.map((p) => p.site).join(', ')}\n` : ''}`
      + `About the user:\n${facts.map((f) => `- ${f.category}/${f.key}: ${f.value}`).join('\n')}`;
    const parse = (text: string) => {
      const json = /\{[\s\S]*\}/.exec(text)?.[0];
      try {
        return json ? Items.safeParse(JSON.parse(json)) : undefined;
      } catch {
        return undefined;
      }
    };

    if (ctx.llm.search) {
      const res = await ctx.llm.search({
        instructions: `You find concrete, current opportunities with web search. Do one or two searches and answer from the result snippets; do not open pages. ${FORMAT} Every url must be a page from your search results; skip anything you can't link.`,
        input,
        location: { city: near, timezone: ctx.timezone },
      });
      const parsed = parse(res.text);
      const items = parsed?.success ? keepSourced(parsed.data.items, res.sources) : [];
      return items.length ? { items, source: 'web search' } : { items: [], note: 'web search found nothing reliable; say so, do not make anything up' };
    }

    // No search on this model (demo mode, tests): the model's own suggestions, clearly without live data.
    const res = await ctx.llm.complete({
      tools: [],
      messages: [
        { role: 'system', content: `You find concrete, current opportunities. ${FORMAT} Never invent URLs; omit url if unsure.` },
        { role: 'user', content: input },
      ],
    });
    const parsed = parse(res.content);
    if (!parsed?.success) return { items: [], note: 'search returned nothing usable' };
    return parsed.data;
  },
});
