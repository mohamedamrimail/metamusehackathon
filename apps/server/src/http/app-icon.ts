import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { ipersons } from '../db/schema.ts';
import type { AppDeps } from './deps.ts';

// The home-screen app: its manifest and icon are the signed-in user's twin face; signed out (or no
// avatar yet) they fall back to the generic i-persons icon in apps/web/public.

export const ICON_SIZES = [180, 192, 512] as const;

/** Center-square crop of an image, scaled to a PNG icon. */
export function squareIcon(path: string, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path,
      '-vf', `crop='min(iw,ih)':'min(iw,ih)',scale=${size}:${size}`, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1']);
    const out: Buffer[] = [];
    ff.stdout.on('data', (b: Buffer) => out.push(b));
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

export function appManifest(icon: (size: number) => string) {
  return {
    name: 'i-persons', short_name: 'i-persons', description: 'Talk to your digital twin.',
    id: '/talk', start_url: '/talk', scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: '#000000', theme_color: '#000000',
    icons: [
      { src: icon(192), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: icon(512), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: icon(512), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

export async function appIconRoutes(app: FastifyInstance, deps: AppDeps) {
  // HACKATHON: rendered icons kept in memory, keyed by avatar file and size (a new avatar = a new key).
  const cache = new Map<string, Buffer>();

  /** The signed-in user's avatar file, if any (no 401: these routes work signed out too). */
  const avatarOf = async (req: FastifyRequest): Promise<string | undefined> => {
    const ok = await req.jwtVerify({ onlyCookie: true }).then(() => true, () => false);
    if (!ok) return undefined;
    const [ip] = await deps.db.select({ id: ipersons.id, avatarUrl: ipersons.avatarUrl }).from(ipersons)
      .where(eq(ipersons.userId, req.user.sub)).orderBy(asc(ipersons.createdAt)).limit(1);
    const file = ip?.avatarUrl?.slice('/api/media/'.length);
    return file && /^[\w-]+\.(jpg|png|webp)$/.test(file) && (file.startsWith(`${ip!.id}-`) || file.startsWith('library-')) ? file : undefined;
  };
  const version = (file: string) => createHash('sha1').update(file).digest('hex').slice(0, 10);

  app.get('/me/manifest.webmanifest', async (req, reply) => {
    const file = await avatarOf(req);
    const icon = file ? (s: number) => `/api/me/app-icon-${s}.png?v=${version(file)}` : (s: number) => `/icon-${s}.png`;
    return reply.type('application/manifest+json').header('Cache-Control', 'private, no-cache').send(JSON.stringify(appManifest(icon)));
  });

  app.get<{ Params: { size: string } }>('/me/app-icon-:size.png', async (req, reply) => {
    const size = Number(req.params.size);
    if (!ICON_SIZES.includes(size as (typeof ICON_SIZES)[number])) return reply.code(404).send({ error: 'not_found' });
    const file = await avatarOf(req);
    if (!file) return reply.redirect(`/icon-${size}.png`);
    const key = `${file}:${size}`;
    let png = cache.get(key);
    if (!png) {
      png = await squareIcon(join(config.UPLOAD_DIR, file), size).catch((err) => { req.log.warn({ err }, 'app icon failed'); return undefined; });
      if (!png) return reply.redirect(`/icon-${size}.png`);
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
      cache.set(key, png);
    }
    return reply.type('image/png').header('Cache-Control', 'private, max-age=86400').send(png);
  });
}
