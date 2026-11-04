import { AGE_RANGES, GENDERS } from '@ipersons/shared';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config.ts';
import { createDb } from '../src/db/client.ts';
import { avatarAssets } from '../src/db/schema.ts';
import { analyzeAvatar, generateImage, metaAvatar, NEUTRAL_LOOKS, neutralPrompt, POSES, posePrompt } from '../src/meta/image.ts';

// Builds the shared neutral-avatar library once: 3 genders × 6 age ranges × 4 looks, upper body,
// 3D animated. Idempotent: reruns only fill what's missing.
// Usage: pnpm gen:neutral-avatars [--limit N] [--analyze] [--poses[=blink,smile,…]]
// Cost (Meta, paid by the platform): $0.01 per image + $0.0025 per SAM call ≈ $0.90 for all 72.

const limit = Number(process.argv[process.argv.indexOf('--limit') + 1]) || Infinity;
if (!config.META_API_KEY) throw new Error('META_API_KEY is required');
const { db, pool } = createDb();
await mkdir(config.UPLOAD_DIR, { recursive: true });

const jobs: { gender: string; ageRange: string; look: number }[] = [];
for (const g of GENDERS) for (const a of AGE_RANGES) for (let look = 0; look < NEUTRAL_LOOKS.length; look++) {
  const [have] = await db.select({ id: avatarAssets.id }).from(avatarAssets).where(and(
    eq(avatarAssets.library, true), eq(avatarAssets.variant, 'base'), eq(avatarAssets.gender, g.id), eq(avatarAssets.ageRange, a),
    sql`${avatarAssets.masks}->>'look' = ${String(look)}`,
  ));
  if (!have) jobs.push({ gender: g.id, ageRange: a, look });
}
const todo = jobs.slice(0, limit);
console.log(`${jobs.length} missing, generating ${todo.length}`);

let done = 0;
let failed = 0;
const worker = async () => {
  for (let job = todo.shift(); job; job = todo.shift()) {
    try {
      const image = await generateImage(neutralPrompt(job.gender, job.ageRange, NEUTRAL_LOOKS[job.look]!));
      const id = randomUUID();
      await writeFile(join(config.UPLOAD_DIR, `library-${id}.jpg`), image);
      const mouth = await metaAvatar.findMouth(image, 'image/jpeg').catch(() => null);
      await db.insert(avatarAssets).values({
        id, lookId: id, library: true, style: 'animated', variant: 'base', gender: job.gender as never, ageRange: job.ageRange as never,
        imageUrl: `/api/media/library-${id}.jpg`, masks: { look: String(job.look), mouth },
      });
      console.log(`ok ${++done} ${job.gender} ${job.ageRange} look ${job.look}${mouth ? '' : ' (no mouth found)'}`);
    } catch (err) {
      failed++;
      console.log(`FAILED ${job.gender} ${job.ageRange} look ${job.look}: ${(err as Error).message.slice(0, 160)}`);
    }
  }
};
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`done: ${done} generated, ${failed} failed`);

// --analyze: SAM person/face/eyes/mouth + cut-out for every library base (≈ $0.01 each).
// --poses:   the A1 pose set for every library avatar (7 images + 28 SAM calls each, ≈ $0.14 each).
const run = async <T>(items: T[], fn: (t: T) => Promise<void>) => {
  const queue = [...items];
  await Promise.all(Array.from({ length: 6 }, async () => { for (let t = queue.shift(); t; t = queue.shift()) await fn(t).catch((err) => console.log('FAILED', (err as Error).message.slice(0, 160))); }));
};
const save = async (stem: string, image: Buffer) => {
  const a = await analyzeAvatar(image, 'image/jpeg');
  let cutout_url: string | undefined;
  if (a.cutout) {
    await writeFile(join(config.UPLOAD_DIR, `${stem}-cutout.png`), a.cutout);
    cutout_url = `/api/media/${stem}-cutout.png`;
  }
  const { cutout: _, samCalls: __, ...boxes } = a;
  return { ...boxes, cutout_url };
};
const bases = () => db.select().from(avatarAssets).where(and(eq(avatarAssets.library, true), eq(avatarAssets.variant, 'base')));

if (process.argv.includes('--analyze')) {
  const todo = (await bases()).filter((b) => !(b.masks as { cutout_url?: string } | null)?.cutout_url);
  console.log(`analyzing ${todo.length} library avatars`);
  await run(todo, async (b) => {
    const image = await readFile(join(config.UPLOAD_DIR, b.imageUrl.slice('/api/media/'.length)));
    const masks = await save(`library-${b.id}`, image);
    await db.update(avatarAssets).set({ masks: { ...(b.masks as object), ...masks } }).where(eq(avatarAssets.id, b.id));
    console.log('analyzed', b.id, masks.cutout_url ? '' : '(no cut-out)');
  });
}

// --poses=blink,smile limits the set (the blink alone makes the avatar feel alive: ≈ $0.02 each).
const posesArg = process.argv.find((a) => a.startsWith('--poses'));
const onlyPoses = posesArg?.includes('=') ? posesArg.split('=')[1]!.split(',') : undefined;
if (posesArg) {
  for (const b of await bases()) {
    const have = new Set((await db.select({ v: avatarAssets.variant }).from(avatarAssets).where(eq(avatarAssets.lookId, b.id))).map((r) => r.v));
    const image = await readFile(join(config.UPLOAD_DIR, b.imageUrl.slice('/api/media/'.length)));
    await run(POSES.filter((p) => !have.has(p.variant) && (!onlyPoses || onlyPoses.includes(p.variant))), async (p) => {
      const out = await metaAvatar.edit(image, 'image/jpeg', posePrompt(p.change));
      const id = randomUUID();
      await writeFile(join(config.UPLOAD_DIR, `library-${id}.jpg`), out);
      const masks = await save(`library-${id}`, out);
      await db.insert(avatarAssets).values({ id, lookId: b.id, library: true, style: b.style, variant: p.variant, gender: b.gender, ageRange: b.ageRange, imageUrl: `/api/media/library-${id}.jpg`, masks });
      console.log('pose', b.id, p.variant);
    });
  }
}
await pool.end();
