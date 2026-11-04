import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ActionError } from '../agent/runtime.ts';
import { FACT_CATEGORIES, decideMemory, listPendingMemory, upsertFact } from '../agent/memory.ts';
import { portfolio } from '../agent/tools/portfolio_status.ts';
import { getWallet } from '../agent/wallet.ts';
import { publishDecision } from '../channels/events.ts';
import { config } from '../config.ts';
import { scanOpportunities } from '../jobs/opportunities.ts';
import { assertPublicUrl } from '../mcp/client.ts';
import { sendWelcome } from '../channels/whatsapp.ts';
import { charge, hasCredit, type Metered } from '../billing/credits.ts';
import { SCENE_PRESETS, presetScene, scenePrompt, type Scene, type ScenePreset } from '../scenes/scenes.ts';
import { editPrompt, POSES, posePrompt, STYLE_PRESETS, withProfile, type AvatarAnalysis } from '../meta/image.ts';
import { actions, avatarAssets, connections, conversations, ipersons, messages, profileFacts, users, wallets } from '../db/schema.ts';
import { avatarRig } from '../lib/rig.ts';
import { ownIperson, requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

const Locale = z.enum(['en', 'fr', 'ar']);
const Timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'unknown timezone');

const CreateIperson = z.object({
  display_name: z.string().trim().min(1).max(60),
  locale: Locale.default('en'),
  timezone: Timezone.default('Africa/Tunis'),
});
const PatchIperson = CreateIperson.partial().extend({
  persona_style: z.string().max(200).optional(),
});
const FactBody = z.object({
  category: z.enum(FACT_CATEGORIES),
  key: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(500),
});
const WalletPatch = z.object({
  per_action_limit_cents: z.number().int().min(0).max(1_000_000).optional(),
  monthly_budget_cents: z.number().int().min(0).max(10_000_000).optional(),
  // HACKATHON: mock top-up, no payment.
  topup_cents: z.number().int().positive().max(100_000).optional(),
});
const ConnectionBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mcp'), url: z.url(), name: z.string().max(60).optional() }),
]);

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const IMAGE_MODEL = config.META_IMAGE_MODEL ?? 'muse-image-1.0';

/** The upload file behind a /api/media url, if this i-person may use it (its own files or the library). */
function mediaFile(ip: { id: string }, url?: string | null): string | undefined {
  if (!url?.startsWith(`/api/media/${ip.id}-`) && !url?.startsWith('/api/media/library-')) return undefined;
  return url.slice('/api/media/'.length);
}
const mimeOf = (file: string) => Object.entries(IMAGE_TYPES).find(([, e]) => file.endsWith(`.${e}`))?.[0] ?? 'image/jpeg';

interface AvatarMeta { selfie?: string; mouth?: { x: number; y: number; w: number }; scene?: Scene; smartScenes?: boolean }

// HACKATHON: in-memory daily cap on paid image generations per i-person (resets on restart).
export const AVATAR_DAILY_LIMIT = 20;
const avatarCredits = new Map<string, { day: string; used: number }>();
function takeAvatarCredit(ipersonId: string, images = 1): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const c = avatarCredits.get(ipersonId);
  const used = c?.day === day ? c.used : 0;
  if (used + images > AVATAR_DAILY_LIMIT) return false;
  avatarCredits.set(ipersonId, { day, used: used + images });
  return true;
}

const bad = (reply: FastifyReply, issues: unknown) => reply.code(400).send({ error: 'invalid', issues });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

export async function ipersonRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  /**
   * What the living-avatar renderer draws: one entry per pose variant (`base` always present).
   * Poses only count while they belong to the avatar in use; otherwise it's the plain image.
   */
  const rigFor = (ip: typeof ipersons.$inferSelect) => avatarRig(db, ip);
  app.addHook('preHandler', requireUser);

  app.post('/ipersons', async (req, reply) => {
    const body = CreateIperson.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues);
    const [existing] = await db.select().from(ipersons).where(eq(ipersons.userId, req.user.sub));
    if (existing) return reply.code(409).send({ error: 'already_exists', iperson: existing });

    const iperson = await db.transaction(async (tx) => {
      await tx.update(users).set({ locale: body.data.locale, timezone: body.data.timezone }).where(eq(users.id, req.user.sub));
      const [ip] = await tx.insert(ipersons).values({ userId: req.user.sub, displayName: body.data.display_name }).returning();
      return ip!;
    });
    return reply.code(201).send({ iperson });
  });

  app.patch<{ Params: { id: string } }>('/ipersons/:id', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const body = PatchIperson.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues);
    const { display_name, persona_style, locale, timezone } = body.data;
    if (locale || timezone) await db.update(users).set({ locale, timezone }).where(eq(users.id, req.user.sub));
    const [row] = await db.update(ipersons).set({ displayName: display_name, personaStyle: persona_style }).where(eq(ipersons.id, ip.id)).returning();
    return { iperson: row };
  });

  // --- avatar ---

  app.post<{ Params: { id: string } }>('/ipersons/:id/avatar/selfie', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const file = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
    if (!file) return bad(reply, 'no file');
    const ext = IMAGE_TYPES[file.mimetype];
    if (!ext) return bad(reply, 'jpeg, png or webp only');
    // A live camera selfie is always fine; uploading any photo file needs a verified WhatsApp number,
    // which ties the account to a real person first. (The form sends `source` before the file.)
    const source = (file.fields.source as { value?: unknown } | undefined)?.value;
    if (source !== 'camera') {
      const [owner] = await db.select({ phone: users.phoneE164 }).from(users).where(eq(users.id, req.user.sub));
      if (!owner?.phone) return reply.code(403).send({ error: 'verify_whatsapp_first', message: 'Link your WhatsApp number to upload a photo, or take a selfie with the camera.' });
    }
    const buf = await file.toBuffer();
    const bill = (m: Metered) => (deps.billing ? charge(db, req.user.sub, m) : Promise.resolve(0));
    await mkdir(config.UPLOAD_DIR, { recursive: true });
    const save = async (kind: string, data: Buffer, extension: string) => {
      const name = `${ip.id}-${kind}-${randomBytes(8).toString('hex')}.${extension}`;
      await writeFile(join(config.UPLOAD_DIR, name), data);
      return `/api/media/${name}`;
    };
    const selfieUrl = await save('selfie', buf, ext);
    // Kept so the avatar studio can restyle the original photo later.
    await db.update(ipersons).set({ avatarMeta: { ...(ip.avatarMeta as AvatarMeta | null), selfie: selfieUrl } }).where(eq(ipersons.id, ip.id));
    const images: { url: string; data: Buffer; mime: string }[] = [];
    // Without AI credit the photo itself is the avatar: no generation, no mouth detection.
    const ai = deps.avatar && (!deps.billing || await hasCredit(db, req.user.sub)) ? deps.avatar : undefined;
    if (ai && takeAvatarCredit(ip.id, 2)) {
      // Stylized versions first, the real photo last; any failure falls back to the photo alone.
      const [profile] = await db.select({ gender: users.gender, ageRange: users.ageRange }).from(users).where(eq(users.id, req.user.sub));
      const styled = await ai.stylize(buf, file.mimetype, profile).catch((err) => {
        req.log.warn({ err }, 'avatar stylize failed');
        return [];
      });
      await bill({ kind: 'image', model: IMAGE_MODEL, images: styled.length });
      for (const data of styled) images.push({ url: await save('avatar', data, 'jpg'), data, mime: 'image/jpeg' });
    }
    images.push({ url: selfieUrl, data: buf, mime: file.mimetype });
    let samCalls = 0;
    const mouths = await Promise.all(images.map((img) => ai?.findMouth(img.data, img.mime).then((m) => { samCalls++; return m; }, (err) => {
      req.log.warn({ err }, 'mouth detection failed');
      return null;
    }) ?? null));
    await bill({ kind: 'sam', model: config.META_SAM_MODEL, images: samCalls });
    return { selfie_url: selfieUrl, options: images.map((i) => i.url), mouths, generated: images.length > 1 };
  });

  app.post<{ Params: { id: string } }>('/ipersons/:id/avatar/select', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const body = z.object({
      url: z.string().regex(/^\/api\/media\/[\w.-]+$/),
      mouth: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.02).max(0.6) }).optional(),
      /** "This is me, and I agree my twin represents me." (Phase 2.4), needed once for a selfie-based twin. */
      this_is_me: z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success || !body.data.url.includes(`/${ip.id}-`)) return bad(reply, 'unknown image');
    const [owner] = await db.select({ consent: users.selfieConsentAt }).from(users).where(eq(users.id, req.user.sub));
    if (!owner?.consent && !body.data.this_is_me) return reply.code(400).send({ error: 'this_is_me_required', message: 'Please confirm that this is you.' });
    if (!owner?.consent) await db.update(users).set({ selfieConsentAt: new Date() }).where(eq(users.id, req.user.sub));
    const meta = (ip.avatarMeta as AvatarMeta | null) ?? {};
    const [row] = await db.update(ipersons).set({ avatarUrl: body.data.url, avatarMouthUrl: null, avatarMeta: { ...meta, mouth: body.data.mouth } }).where(eq(ipersons.id, ip.id)).returning();
    void sendWelcome(deps, req.user.sub).catch(() => {});
    return { iperson: row };
  });

  // Neutral twins (no selfie): pick from the shared library, best matches for the profile first.
  app.get<{ Querystring: { gender?: string; age_range?: string } }>('/avatar/library', async (req) => {
    const rows = await db.select().from(avatarAssets)
      .where(and(eq(avatarAssets.library, true), eq(avatarAssets.variant, 'base'))).orderBy(avatarAssets.createdAt);
    const out = (r: typeof rows[number]) => ({ id: r.id, url: r.imageUrl, gender: r.gender, age_range: r.ageRange });
    const fits = (r: typeof rows[number]) => r.gender === req.query.gender && r.ageRange === req.query.age_range;
    const matching = rows.filter(fits).slice(0, 4);
    return { matching: matching.map(out), others: rows.filter((r) => !matching.includes(r)).map(out) };
  });

  app.post<{ Params: { id: string } }>('/ipersons/:id/avatar/neutral', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const body = z.object({ asset_id: z.uuid() }).safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues);
    const [asset] = await db.select().from(avatarAssets).where(and(eq(avatarAssets.id, body.data.asset_id), eq(avatarAssets.library, true)));
    if (!asset) return bad(reply, 'unknown avatar');
    const mouth = (asset.masks as { mouth?: AvatarMeta['mouth'] } | null)?.mouth ?? undefined;
    const meta = (ip.avatarMeta as AvatarMeta | null) ?? {};
    const [row] = await db.update(ipersons).set({ avatarUrl: asset.imageUrl, avatarAssetId: asset.id, avatarMouthUrl: null, avatarMeta: { ...meta, mouth } })
      .where(eq(ipersons.id, ip.id)).returning();
    void sendWelcome(deps, req.user.sub).catch(() => {});
    return { iperson: row };
  });

  // Avatar studio: restyle the original selfie with a preset, or change the current look in words.
  app.get('/avatar/styles', async () => ({
    styles: STYLE_PRESETS.map(({ id, label }) => ({ id, label })),
    enabled: Boolean(deps.avatar),
  }));

  app.post<{ Params: { id: string } }>('/ipersons/:id/avatar/customize', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const body = z.union([
      z.object({ style: z.enum(STYLE_PRESETS.map((p) => p.id) as [string, ...string[]]) }),
      z.object({ instruction: z.string().trim().min(3).max(300) }),
    ]).safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues);
    if (!deps.avatar) return reply.code(503).send({ error: 'avatar_unavailable' });
    if (deps.billing && !(await hasCredit(db, req.user.sub))) return reply.code(402).send({ error: 'no_credit', message: 'Your AI credit is used up.' });
    const bill = (m: Metered) => (deps.billing ? charge(db, req.user.sub, m) : Promise.resolve(0));
    if (!takeAvatarCredit(ip.id)) return reply.code(429).send({ error: 'daily_limit', message: `Up to ${AVATAR_DAILY_LIMIT} new looks a day.` });

    const meta = (ip.avatarMeta as AvatarMeta | null) ?? {};
    // Presets restyle the original selfie, or the chosen library avatar for a neutral twin; words edit
    // the current look. The first edit of a library avatar becomes the user's own copy.
    const libraryBase = ip.avatarUrl?.startsWith('/api/media/library-') ? ip.avatarUrl : undefined;
    const base = 'style' in body.data ? meta.selfie ?? libraryBase : ip.avatarUrl;
    const file = base?.startsWith(`/api/media/${ip.id}-`) || base?.startsWith('/api/media/library-') ? base.slice('/api/media/'.length) : undefined;
    const image = file && await readFile(join(config.UPLOAD_DIR, file)).catch(() => undefined);
    if (!file || !image) return reply.code(409).send({ error: 'no_photo', message: 'Take a new selfie first.' });
    const mime = Object.entries(IMAGE_TYPES).find(([, e]) => file.endsWith(`.${e}`))?.[0] ?? 'image/jpeg';

    const [profile] = await db.select({ gender: users.gender, ageRange: users.ageRange }).from(users).where(eq(users.id, req.user.sub));
    const prompt = 'style' in body.data
      ? withProfile(STYLE_PRESETS.find((p) => p.id === (body.data as { style: string }).style)!.prompt, profile?.gender, profile?.ageRange)
      : editPrompt(body.data.instruction);
    let out: Buffer;
    try {
      out = await deps.avatar.edit(image, mime, prompt);
    } catch (err) {
      req.log.warn({ err }, 'avatar customize failed');
      const blocked = /content_policy/.test(String(err));
      return reply.code(422).send({ error: blocked ? 'blocked' : 'failed', message: blocked ? "That change isn't allowed. Try something else." : "Couldn't make that look. Try again." });
    }
    await bill({ kind: 'image', model: IMAGE_MODEL, images: 1 });
    const name = `${ip.id}-avatar-${randomBytes(8).toString('hex')}.jpg`;
    await writeFile(join(config.UPLOAD_DIR, name), out);
    const mouth = await deps.avatar.findMouth(out, 'image/jpeg').then(async (m) => {
      await bill({ kind: 'sam', model: config.META_SAM_MODEL, images: 1 });
      return m;
    }, () => null);
    return { url: `/api/media/${name}`, mouth };
  });

  // --- living avatar (A1): pose set + SAM masks + cut-outs for the current look ---

  /** Before generating: what it costs (shown to the user), at Meta prices plus the platform fee. */
  const lifeCost = () => {
    const meta = POSES.length * config.PRICE_IMAGE + (POSES.length + 1) * 4 * config.PRICE_SAM_IMAGE;
    return { images: POSES.length, sam_calls: (POSES.length + 1) * 4, cost_usd: Math.round(meta * (1 + config.AI_PLATFORM_FEE_RATIO) * 100) / 100 };
  };
  app.get<{ Params: { id: string } }>('/ipersons/:id/avatar/life', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    return { ...lifeCost(), enabled: Boolean(deps.avatar), rig: await rigFor(ip) };
  });

  app.post<{ Params: { id: string } }>('/ipersons/:id/avatar/life', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    if (!deps.avatar) return reply.code(503).send({ error: 'avatar_unavailable' });
    if (deps.billing && !(await hasCredit(db, req.user.sub))) return reply.code(402).send({ error: 'no_credit', message: 'Your AI credit is used up.' });
    if (!takeAvatarCredit(ip.id, POSES.length)) return reply.code(429).send({ error: 'daily_limit', message: `Up to ${AVATAR_DAILY_LIMIT} new images a day.` });
    const file = mediaFile(ip, ip.avatarUrl);
    const image = file && await readFile(join(config.UPLOAD_DIR, file)).catch(() => undefined);
    if (!file || !image) return reply.code(409).send({ error: 'no_avatar', message: 'Choose an avatar first.' });
    const mime = mimeOf(file);
    const bill = (m: Metered) => (deps.billing ? charge(db, req.user.sub, m) : Promise.resolve(0));
    const ai = deps.avatar;

    // All poses in parallel; a failed pose is simply missing (the renderer needs only `base`).
    const poses = await Promise.all(POSES.map(async (p) => {
      const out = await ai.edit(image, mime, posePrompt(p.change)).catch((err) => { req.log.warn({ err, pose: p.variant }, 'pose failed'); return null; });
      return out ? { variant: p.variant, image: out, mime: 'image/jpeg' } : null;
    }));
    const made = poses.filter((p): p is NonNullable<typeof p> => Boolean(p));
    await bill({ kind: 'image', model: IMAGE_MODEL, images: made.length });

    const all = [{ variant: 'base', image, mime }, ...made];
    const analyses = await Promise.all(all.map((p) => ai.analyze(p.image, p.mime).catch(() => ({ samCalls: 0 }) as AvatarAnalysis)));
    await bill({ kind: 'sam', model: config.META_SAM_MODEL, images: analyses.reduce((n, a) => n + a.samCalls, 0) });

    const lookId = randomUUID();
    const rows = await Promise.all(all.map(async (p, i) => {
      const a = analyses[i]!;
      const stem = `${ip.id}-${p.variant === 'base' ? 'base' : 'pose'}-${randomBytes(6).toString('hex')}`;
      const imageUrl = p.variant === 'base' ? ip.avatarUrl! : `/api/media/${stem}.jpg`;
      if (p.variant !== 'base') await writeFile(join(config.UPLOAD_DIR, `${stem}.jpg`), p.image);
      let cutoutUrl: string | undefined;
      if (a.cutout) {
        await writeFile(join(config.UPLOAD_DIR, `${stem}-cutout.png`), a.cutout);
        cutoutUrl = `/api/media/${stem}-cutout.png`;
      }
      const { cutout: _, samCalls: __, ...boxes } = a;
      return {
        id: p.variant === 'base' ? lookId : randomUUID(), ipersonId: ip.id, lookId, style: 'personal', variant: p.variant,
        imageUrl, masks: { ...boxes, cutout_url: cutoutUrl },
      };
    }));
    await db.insert(avatarAssets).values(rows);
    const mouth = analyses[0]!.mouth;
    const meta = (ip.avatarMeta as AvatarMeta | null) ?? {};
    const [row] = await db.update(ipersons).set({ avatarAssetId: lookId, avatarMeta: { ...meta, mouth: mouth ? { x: mouth.x, y: mouth.y, w: mouth.w } : meta.mouth } })
      .where(eq(ipersons.id, ip.id)).returning();
    return { iperson: row, rig: await rigFor(row!), missing: POSES.length - made.length };
  });

  // --- scenes (A4) ---
  // Preset scenes are stock photos (Pexels): listed only when PEXELS_API_KEY is set.
  app.get('/avatar/scenes', async () => ({ presets: config.PEXELS_API_KEY ? SCENE_PRESETS.map(({ id, label }) => ({ id, label })) : [], custom: Boolean(deps.avatar) }));

  app.post<{ Params: { id: string } }>('/ipersons/:id/avatar/scene', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const body = z.union([
      z.object({ preset: z.enum(SCENE_PRESETS.map((p) => p.id) as [ScenePreset, ...ScenePreset[]]) }),
      z.object({ prompt: z.string().trim().min(3).max(200) }),
      z.object({ smart: z.boolean() }),
    ]).safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues);
    const meta = (ip.avatarMeta as AvatarMeta | null) ?? {};
    let scene: Scene | undefined;
    if ('smart' in body.data) {
      const [row] = await db.update(ipersons).set({ avatarMeta: { ...meta, smartScenes: body.data.smart } }).where(eq(ipersons.id, ip.id)).returning();
      return { iperson: row };
    }
    if ('preset' in body.data) {
      scene = await presetScene(body.data.preset).catch((err) => { req.log.warn({ err }, 'scene failed'); return undefined; });
      if (!scene) return reply.code(502).send({ error: 'scene_unavailable', message: 'Couldn’t load that scene. Try another.' });
    } else {
      if (!deps.avatar) return reply.code(503).send({ error: 'avatar_unavailable' });
      if (deps.billing && !(await hasCredit(db, req.user.sub))) return reply.code(402).send({ error: 'no_credit', message: 'Your AI credit is used up.' });
      if (!takeAvatarCredit(ip.id)) return reply.code(429).send({ error: 'daily_limit', message: `Up to ${AVATAR_DAILY_LIMIT} new images a day.` });
      const image = await deps.avatar.generate(scenePrompt(body.data.prompt)).catch((err) => { req.log.warn({ err }, 'scene generation failed'); return null; });
      if (!image) return reply.code(422).send({ error: 'failed', message: 'Couldn’t make that scene. Try different words.' });
      if (deps.billing) await charge(db, req.user.sub, { kind: 'image', model: IMAGE_MODEL, images: 1 });
      const name = `${ip.id}-scene-${randomBytes(6).toString('hex')}.jpg`;
      await writeFile(join(config.UPLOAD_DIR, name), image);
      scene = { id: 'custom', url: `/api/media/${name}` };
    }
    const [row] = await db.update(ipersons).set({ avatarMeta: { ...meta, scene } }).where(eq(ipersons.id, ip.id)).returning();
    return { iperson: row, scene };
  });

  app.get<{ Params: { file: string } }>('/media/:file', async (req, reply) => {
    const file = req.params.file;
    if (!/^[\w-]+\.(jpg|png|webp|svg)$/.test(file)) return notFound(reply);
    // Files are named "<iperson id>-…": only the owner may read them. Library avatars are shared.
    const shared = file.startsWith('library-') || file.startsWith('scene-') || file.startsWith('connector-');
    if (!shared && !(await ownIperson(deps, req, file.slice(0, 36)))) return notFound(reply);
    const path = join(config.UPLOAD_DIR, file);
    if (!(await stat(path).catch(() => null))) return notFound(reply);
    if (file.endsWith('.svg')) {
      // Admin-uploaded SVG icons: served so they can never run scripts on our origin.
      return reply.type('image/svg+xml').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=86400').send(createReadStream(path));
    }
    const type = Object.entries(IMAGE_TYPES).find(([, e]) => file.endsWith(e))![0];
    return reply.type(type).header('Cache-Control', 'private, max-age=86400').send(createReadStream(path));
  });

  // --- facts ---

  // --- memories held after outside content (Keep / Discard) ---

  app.get<{ Params: { id: string } }>('/ipersons/:id/memory/pending', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    return { items: await listPendingMemory(db, ip.id) };
  });

  app.post<{ Params: { id: string; kind: string; item: string } }>('/ipersons/:id/memory/pending/:kind/:item', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    const body = z.object({ keep: z.boolean() }).safeParse(req.body);
    const kind = z.enum(['fact', 'rule']).safeParse(req.params.kind);
    if (!ip || !kind.success || !z.uuid().safeParse(req.params.item).success) return notFound(reply);
    if (!body.success) return bad(reply, body.error.issues);
    const done = await decideMemory(db, ip.id, kind.data, req.params.item, body.data.keep);
    return done ? { ok: true } : reply.code(409).send({ error: 'already_handled' });
  });

  app.get<{ Params: { id: string } }>('/ipersons/:id/facts', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const facts = await db.select().from(profileFacts).where(and(eq(profileFacts.ipersonId, ip.id), eq(profileFacts.status, 'active'))).orderBy(profileFacts.category, desc(profileFacts.updatedAt));
    return { facts };
  });

  app.post<{ Params: { id: string } }>('/ipersons/:id/facts', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const body = z.union([FactBody.extend({ source: z.enum(['onboarding', 'user_edit']).default('user_edit') }), z.array(FactBody.extend({ source: z.enum(['onboarding', 'user_edit']).default('onboarding') })).max(50)]).safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues);
    const list = Array.isArray(body.data) ? body.data : [body.data];
    const facts = [];
    for (const f of list) facts.push(await upsertFact(db, ip.id, { ...f, confidence: 1 }));
    return reply.code(201).send({ facts });
  });

  app.patch<{ Params: { id: string; factId: string } }>('/ipersons/:id/facts/:factId', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip || !z.uuid().safeParse(req.params.factId).success) return notFound(reply);
    const body = z.object({ value: z.string().trim().min(1).max(500).optional(), visibility: z.enum(['private', 'public']).optional() })
      .refine((b) => b.value !== undefined || b.visibility !== undefined).safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues);
    // Editing the text makes it the user's own fact; flipping visibility (Phase 6a) leaves the source alone.
    const [fact] = await db.update(profileFacts)
      .set({ ...(body.data.value !== undefined ? { value: body.data.value, source: 'user_edit' as const, confidence: 1 } : {}), ...(body.data.visibility ? { visibility: body.data.visibility } : {}), updatedAt: new Date() })
      .where(and(eq(profileFacts.id, req.params.factId), eq(profileFacts.ipersonId, ip.id))).returning();
    return fact ? { fact } : notFound(reply);
  });

  app.delete<{ Params: { id: string; factId: string } }>('/ipersons/:id/facts/:factId', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip || !z.uuid().safeParse(req.params.factId).success) return notFound(reply);
    const [gone] = await db.delete(profileFacts).where(and(eq(profileFacts.id, req.params.factId), eq(profileFacts.ipersonId, ip.id))).returning();
    return gone ? { ok: true } : notFound(reply);
  });

  // --- actions (audit log) ---

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/ipersons/:id/actions', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    await deps.runtime.expireStale(ip.id);
    const status = z.enum(['proposed', 'confirmed', 'rejected', 'expired', 'done', 'failed']).optional().safeParse(req.query.status);
    if (!status.success) return bad(reply, 'unknown status');
    const rows = await db.select().from(actions)
      .where(and(eq(actions.ipersonId, ip.id), status.data ? eq(actions.status, status.data) : undefined))
      .orderBy(desc(actions.createdAt)).limit(200);
    // The confirm token is a bearer secret for WhatsApp buttons; never send it to the browser.
    return { actions: rows.map(({ confirmToken: _, ...a }) => a) };
  });

  const decide = (approve: boolean) => async (req: { params: { id: string }; user: { sub: string } }, reply: FastifyReply) => {
    if (!z.uuid().safeParse(req.params.id).success) return notFound(reply);
    const [row] = await db.select({ ipersonId: actions.ipersonId }).from(actions)
      .innerJoin(ipersons, eq(ipersons.id, actions.ipersonId))
      .where(and(eq(actions.id, req.params.id), eq(ipersons.userId, req.user.sub)));
    if (!row) return notFound(reply);
    try {
      const result = await deps.runtime.decide({ ipersonId: row.ipersonId, actionId: req.params.id, approve });
      publishDecision(deps.bus, row.ipersonId, result);
      const { confirmToken: _, ...action } = result.action;
      return { action, reply: result.followUp?.reply ?? null };
    } catch (err) {
      if (err instanceof ActionError) return reply.code(409).send({ error: err.code, message: err.message });
      throw err;
    }
  };
  app.post<{ Params: { id: string } }>('/actions/:id/confirm', (req, reply) => decide(true)(req, reply));
  app.post<{ Params: { id: string } }>('/actions/:id/reject', (req, reply) => decide(false)(req, reply));

  // --- wallet & portfolio ---

  app.get<{ Params: { id: string } }>('/ipersons/:id/wallet', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    return { wallet: (await getWallet(db, ip.id)) ?? null, simulated: true };
  });

  app.patch<{ Params: { id: string } }>('/ipersons/:id/wallet', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const body = WalletPatch.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues);
    const w = await getWallet(db, ip.id);
    if (!w) return notFound(reply);
    const [wallet] = await db.update(wallets).set({
      perActionLimitCents: body.data.per_action_limit_cents,
      monthlyBudgetCents: body.data.monthly_budget_cents,
      balanceCents: body.data.topup_cents ? w.balanceCents + body.data.topup_cents : undefined,
    }).where(eq(wallets.id, w.id)).returning();
    return { wallet, simulated: true };
  });

  app.get<{ Params: { id: string } }>('/ipersons/:id/portfolio', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    return portfolio({ db, ipersonId: ip.id, now: new Date() });
  });

  // --- connections ---

  app.get<{ Params: { id: string } }>('/ipersons/:id/connections', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const rows = await db.select({ id: connections.id, kind: connections.kind, config: connections.config, enabled: connections.enabled, createdAt: connections.createdAt })
      .from(connections).where(eq(connections.ipersonId, ip.id));
    const [user] = await db.select({ phone: users.phoneE164 }).from(users).where(eq(users.id, req.user.sub));
    return { connections: rows, whatsapp_phone: user?.phone ?? null };
  });

  app.post<{ Params: { id: string } }>('/ipersons/:id/connections', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const body = ConnectionBody.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.issues);
    try {
      await assertPublicUrl(body.data.url);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
    const [row] = await db.insert(connections).values({ ipersonId: ip.id, kind: 'mcp', config: { url: body.data.url, name: body.data.name ?? null } }).returning();
    return reply.code(201).send({ connection: { ...row, tokenEnc: undefined } });
  });

  app.delete<{ Params: { id: string; connId: string } }>('/ipersons/:id/connections/:connId', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip || !z.uuid().safeParse(req.params.connId).success) return notFound(reply);
    const [gone] = await db.delete(connections).where(and(eq(connections.id, req.params.connId), eq(connections.ipersonId, ip.id))).returning();
    return gone ? { ok: true } : notFound(reply);
  });

  // Demo trigger for the background scan ("it works while you sleep" without waiting 6 hours).
  app.post<{ Params: { id: string } }>('/ipersons/:id/scan', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    return scanOpportunities(deps, ip.id);
  });

  // --- transcript (Talk screen history) ---

  app.get<{ Params: { id: string } }>('/ipersons/:id/messages', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const rows = await db.select({ role: messages.role, content: messages.content, createdAt: messages.createdAt, channel: conversations.channel })
      .from(messages).innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(conversations.ipersonId, ip.id)).orderBy(desc(messages.seq)).limit(60);
    return { messages: rows.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).reverse() };
  });
}
