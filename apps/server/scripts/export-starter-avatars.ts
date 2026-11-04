import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from '../src/config.ts';
import { createDb } from '../src/db/client.ts';

// Maintainer tool: exports the starter avatar set that ships in the repo (apps/server/starter-avatars/): one look
// per gender × age range from the neutral library, every pose, resized to 768 px (JPEG poses, WebP cut-outs).
// seed:local imports it on first start. Usage: pnpm --filter @ipersons/server export:starter-avatars

const run = promisify(execFile);
const OUT = fileURLToPath(new URL('../starter-avatars', import.meta.url));
const { pool } = createDb();

const looks = await pool.query<{ look_id: string }>(
  `select distinct on (gender, age_range) look_id from avatar_assets where library and variant = 'base' order by gender, age_range, created_at, id`,
);
const rows = await pool.query(
  `select id, look_id, style, variant, gender, age_range, image_url, masks from avatar_assets where library and look_id = any($1) order by look_id, variant`,
  [looks.rows.map((l) => l.look_id)],
);
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const name = (url: string) => url.replace(/^\/api\/media\//, '');
const manifest = [];
for (const r of rows.rows) {
  const img = name(r.image_url);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', join(config.UPLOAD_DIR, img), '-vf', 'scale=768:-2', '-q:v', '4', join(OUT, img)]);
  const masks = { ...(r.masks ?? {}) };
  if (masks.cutout_url) {
    const cut = name(masks.cutout_url).replace(/\.png$/, '.webp');
    await run('ffmpeg', ['-v', 'error', '-y', '-i', join(config.UPLOAD_DIR, name(masks.cutout_url)), '-vf', 'scale=768:-2', '-c:v', 'libwebp', '-quality', '80', join(OUT, cut)]);
    masks.cutout_url = `/api/media/${cut}`;
  }
  manifest.push({ id: r.id, lookId: r.look_id, style: r.style, variant: r.variant, gender: r.gender, ageRange: r.age_range, imageUrl: r.image_url, masks });
}
await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
await pool.end();
console.log(`${looks.rows.length} looks, ${manifest.length} poses exported to ${OUT}`);
