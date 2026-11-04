import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { firstName } from '../public/visitor.ts';
import type { AppDeps } from './deps.ts';
import { publicTwin } from './public.ts';

// Link previews (WhatsApp, LinkedIn, X…) of a public twin page show that twin: its name, bio and avatar, instead of the
// site's default card. Only what the public page itself shows; nothing for a twin that isn't public.

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** index.html with the twin's preview tags for /@handle, or undefined to serve the page as is. */
export async function twinPageHtml(deps: Pick<AppDeps, 'db'>, webDist: string, path: string): Promise<string | undefined> {
  const m = /^\/@([a-z0-9-]{3,30})(?:[/?#]|$)/i.exec(path);
  if (!m) return undefined;
  const t = await publicTwin(deps.db, m[1]!);
  if (!t) return undefined;
  const html = await readFile(join(webDist, 'index.html'), 'utf8').catch(() => undefined);
  if (!html) return undefined;
  const handle = t.ip.handle!;
  const name = firstName(t.owner);
  const title = `${t.ip.displayName}, ${name}'s i-person`;
  const desc = (t.ip.publicBio?.trim() || `Talk to ${name}'s digital twin: ask about ${name}, leave a message or ask to meet. ${name} approves every request.`).slice(0, 200);
  const url = `${config.PUBLIC_URL}/@${handle}`;
  const image = t.ip.avatarUrl ? `${config.PUBLIC_URL}${t.ip.avatarUrl.replace(/^\/api\/media\//, `/api/public/${handle}/media/`)}` : `${config.PUBLIC_URL}/og-image.png`;
  const tags = [
    `<title>${esc(title)} · i-persons</title>`,
    `<meta name="description" content="${esc(desc)}" />`,
    `<meta property="og:type" content="profile" />`, `<meta property="og:site_name" content="i-persons" />`,
    `<meta property="og:url" content="${esc(url)}" />`, `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`, `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:alt" content="${esc(`${t.ip.displayName}, the digital twin of ${name}`)}" />`,
    `<meta name="twitter:card" content="summary" />`, `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(desc)}" />`, `<meta name="twitter:image" content="${esc(image)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
  ].join('\n    ');
  return html.replace(/<!--seo-->[\s\S]*?<!--\/seo-->/, tags);
}
