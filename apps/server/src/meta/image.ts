import { timedMeta } from '../lib/call-log.ts';
import { decodeMaskToRaster, parseImageStream, recordsOfKind } from '@meta-sam/parser';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.ts';

const execFileP = promisify(execFile);

// Avatar from a selfie: Muse Image stylizes it, SAM 3.1 finds the mouth for lip-sync.
// Verified live Oct 29 (docs: dev.meta.ai/docs/image-generation, /docs/media-segmentation).

/** Mouth center and width, as fractions of the image (what the web Avatar draws over). */
export interface Mouth { x: number; y: number; w: number }

export interface AvatarMaker {
  /** Stylized portraits of the person in `photo`, one per default style; failed styles are left out. */
  stylize(photo: Buffer, mime: string, profile?: { gender?: string | null; ageRange?: string | null }): Promise<Buffer[]>;
  /** One Muse Image edit of `image` following `instruction`. */
  edit(image: Buffer, mime: string, instruction: string): Promise<Buffer>;
  findMouth(image: Buffer, mime: string): Promise<Mouth | null>;
  /** SAM person/face/eyes/mouth plus the cut-out, for the living avatar. */
  analyze(image: Buffer, mime: string): Promise<AvatarAnalysis>;
  /** Text-to-image (scenes). */
  generate(prompt: string): Promise<Buffer>;
}

// Identity always comes from the selfie; framing is upper body so the renderer can breathe and gesture.
const SAME_PERSON = 'of the same person: keep their face shape, skin tone, hair, eyes, and any glasses, beard or headscarf clearly recognisable. Upper-body portrait framed from mid-chest to just above the head, arms relaxed and visible, front-facing, neutral expression with the mouth closed, eyes open looking at the camera, plain light-grey background, soft studio light.';

/** Looks offered in the avatar studio; each restyles the original selfie (best likeness). */
export const STYLE_PRESETS = [
  { id: 'animated', label: '3D animated', prompt: `Turn this selfie into a friendly stylized 3D animated character portrait ${SAME_PERSON}` },
  { id: 'painted', label: 'Painted', prompt: `Turn this selfie into a polished semi-realistic digital painting portrait ${SAME_PERSON}` },
  { id: 'anime', label: 'Anime', prompt: `Turn this selfie into a clean anime-style character portrait ${SAME_PERSON}` },
  { id: 'watercolor', label: 'Watercolor', prompt: `Turn this selfie into a soft watercolor illustration portrait ${SAME_PERSON}` },
  { id: 'comic', label: 'Comic', prompt: `Turn this selfie into a bold comic-book illustration portrait with clean ink lines ${SAME_PERSON}` },
  { id: 'headshot', label: 'Pro headshot', prompt: `Turn this selfie into a professional corporate portrait photo ${SAME_PERSON.replace('plain light-grey background', 'blurred modern office background')}` },
  { id: 'pixel', label: 'Pixel art', prompt: `Turn this selfie into a detailed 32-bit pixel art portrait ${SAME_PERSON}` },
] as const;
const DEFAULT_STYLES = ['animated', 'painted'];

/** Free-text changes keep who it is and how the lip-sync needs the face. */
export const editPrompt = (instruction: string) =>
  `${instruction.trim()}. Keep the same person, the same art style, the face clearly visible and facing the camera, mouth closed and relaxed, the same upper-body framing.`;

/** Adds the profile words ("a woman in her late thirties") to a selfie prompt; the selfie still decides identity. */
export const withProfile = (prompt: string, gender?: string | null, ageRange?: string | null) =>
  gender === 'unspecified' || (!gender && !ageRange) ? prompt : `${prompt} The person is ${personWords(gender, ageRange)}; if the photo disagrees, follow the photo.`;

/** The living avatar's pose set (A1). Each is an edit of the chosen base, identical otherwise. */
export const POSES = [
  { variant: 'blink', change: 'the eyes fully closed, as in the middle of a blink' },
  { variant: 'smile', change: 'a warm, natural smile with lips slightly apart' },
  { variant: 'thinking', change: 'one hand near the chin, looking slightly up, thoughtful' },
  { variant: 'wave', change: 'one hand raised in a friendly wave' },
  { variant: 'thumbs_up', change: 'one hand giving a thumbs up, a happy smile' },
  { variant: 'listening', change: 'leaning slightly forward, attentive, eyebrows a little raised' },
  { variant: 'surprised', change: 'a surprised expression, eyebrows raised, mouth slightly open' },
] as const;
export const posePrompt = (change: string) =>
  `Same character, same identity, same art style, same clothes, same framing, same plain light-grey background and same lighting. Only change: ${change}. Keep the face front-facing and fully visible.`;

/** Phase A framing: upper body, so the renderer can breathe, sway and gesture (A1). */
export const UPPER_BODY = 'Upper-body portrait framed from mid-chest to just above the head, arms relaxed and visible, front-facing, neutral expression with the mouth closed, eyes open looking at the camera, plain light-grey background, soft studio light.';

const AGE_WORDS: Record<string, string> = {
  '18-24': 'in their early twenties', '25-34': 'in their late twenties or early thirties', '35-44': 'in their late thirties',
  '45-54': 'in their late forties', '55-64': 'in their late fifties', '65+': 'in their late sixties',
};
/** "a woman in her late thirties"; nothing about gender for "Prefer not to say". */
export function personWords(gender?: string | null, ageRange?: string | null): string {
  const age = ageRange ? AGE_WORDS[ageRange] : undefined;
  if (gender === 'woman') return `a woman${age ? ` ${age.replace('their', 'her')}` : ''}`;
  if (gender === 'man') return `a man${age ? ` ${age.replace('their', 'his')}` : ''}`;
  return `an androgynous, gender-neutral person${age ? ` ${age}` : ''}`;
}

/** A neutral library avatar: clearly a stylized character, not a photo of anyone. */
export const neutralPrompt = (gender: string, ageRange: string, look: string) =>
  `A friendly stylized 3D animated character (not photorealistic) of ${personWords(gender, ageRange)}, ${look}. ${UPPER_BODY}`;

/** The 4 looks per gender × age range: varied skin tones, hair, glasses and headscarf. */
export const NEUTRAL_LOOKS = [
  'deep brown skin, short natural hair, a plain navy sweater',
  'light olive skin, wavy dark hair, round glasses, a white shirt',
  'medium brown skin, wearing a soft beige headscarf, a green cardigan',
  'fair skin with freckles, light brown hair, a grey hoodie',
];

const dataUrl = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString('base64')}`;

async function post(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  // DEMO: the Meta AI calls panel (lib/call-log.ts) logs each image and SAM call with its latency.
  const b = body as { model?: string; input?: { content?: { type: string; text?: string }[] }[] };
  const sam = b.model === config.META_SAM_MODEL;
  const what = sam
    ? `found "${b.input?.[0]?.content?.find((c) => c.type === 'input_text')?.text ?? 'object'}" in the avatar (mask + box)`
    : path === '/images/edits' ? 'edited the avatar image (style, pose or scene)' : 'generated an image';
  return timedMeta(sam ? 'SAM 3.1' : 'Muse Image', what, () => postRaw(path, body, timeoutMs));
}

async function postRaw(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${config.META_BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.META_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status} ${JSON.stringify(data.error ?? '').slice(0, 200)}`);
  return data;
}

/** SAM's output_text: `0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;…|>`, empty when nothing matched. */
export function parseSamBox(text: string): Mouth | null {
  const m = /<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)\|>/.exec(text);
  if (!m) return null;
  const [x1, y1, x2, y2, w, h] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (!w || !h || x2 <= x1) return null;
  return { x: (x1 + x2) / 2 / w, y: (y1 + y2) / 2 / h, w: Math.min(0.6, Math.max(0.02, (x2 - x1) / w)) };
}

async function museEdit(image: Buffer, mime: string, prompt: string): Promise<Buffer> {
  const res = await post('/images/edits', {
    model: config.META_IMAGE_MODEL ?? 'muse-image-1.0',
    prompt,
    images: [{ image_url: dataUrl(image, mime) }],
    n: 1,
    size: '1024x1024',
    output_format: 'jpeg',
    // 'low' is one pass: ~9 s instead of ~22 s, same likeness in our tests.
    reasoning_strength: 'low',
  }, 90_000);
  const b64 = (res.data as { b64_json?: string }[] | undefined)?.[0]?.b64_json;
  if (!b64) throw new Error('/images/edits returned no image');
  return Buffer.from(b64, 'base64');
}

export interface Box { x1: number; y1: number; x2: number; y2: number }
/** What the renderer needs from SAM, in 0–1 image coordinates, plus a transparent person cut-out (PNG). */
export interface AvatarAnalysis {
  person?: Box; face?: Box; eyes?: Box; mouth?: Mouth & { box: Box };
  cutout?: Buffer;
  /** SAM calls made (each billed as one image). */
  samCalls: number;
}

interface Segment { bounds: { left: number; top: number; right: number; bottom: number }; raster: Uint8Array; width: number; height: number }

/** SAM 3.1 text-prompt segmentation, decoded with Meta's @meta-sam/parser. */
export async function segment(image: Buffer, mime: string, prompt: string): Promise<{ frame: { w: number; h: number }; segments: Segment[] }> {
  const res = await post('/responses', {
    model: config.META_SAM_MODEL,
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: dataUrl(image, mime) }] }],
  }, 30_000);
  const text = ((res.output ?? []) as { content?: { text?: string }[] }[]).flatMap((o) => o.content ?? []).map((c) => c.text ?? '').join('');
  const frame = { w: Number(/;w=(\d+)/.exec(text)?.[1] ?? 0), h: Number(/;h=(\d+)/.exec(text)?.[1] ?? 0) };
  async function* events() {
    yield { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: text } as never;
    yield { type: 'response.output_text.done', item_id: 'm', output_index: 0, content_index: 0, text } as never;
    yield { type: 'response.completed' } as never;
  }
  const parsed = parseImageStream(events());
  for await (const _ of parsed) { /* drain: we only need the final result */ }
  const result = await parsed.finalResult;
  const segments = recordsOfKind(result.records, 'mask').map((m) => ({ bounds: m.bounds, raster: decodeMaskToRaster(m.mask), width: m.mask.width, height: m.mask.height }));
  return { frame, segments };
}

const boxOf = (b: Segment['bounds'], f: { w: number; h: number }): Box => ({ x1: b.left / f.w, y1: b.top / f.h, x2: b.right / f.w, y2: b.bottom / f.h });

/** Person cut-out: the mask (which covers only its box) placed in the full frame, as the image's alpha. */
async function cutoutPng(image: Buffer, seg: Segment, frame: { w: number; h: number }): Promise<Buffer> {
  const full = Buffer.alloc(frame.w * frame.h);
  const bw = seg.bounds.right - seg.bounds.left;
  const bh = seg.bounds.bottom - seg.bounds.top;
  for (let y = 0; y < bh; y++) {
    const row = Math.min(seg.height - 1, Math.floor((y * seg.height) / bh)) * seg.width;
    for (let x = 0; x < bw; x++) {
      if (seg.raster[row + Math.min(seg.width - 1, Math.floor((x * seg.width) / bw))]) full[(seg.bounds.top + y) * frame.w + seg.bounds.left + x] = 255;
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'cutout-'));
  try {
    await writeFile(join(dir, 'in.jpg'), image);
    await writeFile(join(dir, 'mask.raw'), full);
    await execFileP('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(dir, 'in.jpg'), '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${frame.w}x${frame.h}`, '-i', join(dir, 'mask.raw'),
      // Pull the edge in 2 px (no background fringe), soften it 1 px; scaled to 1024 to keep the PNG small.
      '-filter_complex', '[1]erosion,erosion,boxblur=1[a];[0][a]alphamerge,scale=1024:-1', '-frames:v', '1', join(dir, 'out.png')]);
    return await readFile(join(dir, 'out.png'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Person, face, eyes and mouth in parallel; any of them may be missing. */
export async function analyzeAvatar(image: Buffer, mime: string): Promise<AvatarAnalysis> {
  const prompts = ['person', 'face', 'eyes', 'mouth'] as const;
  const results = await Promise.allSettled(prompts.map((p) => segment(image, mime, p)));
  const out: AvatarAnalysis = { samCalls: results.filter((r) => r.status === 'fulfilled').length };
  const first = (i: number) => {
    const r = results[i]!;
    return r.status === 'fulfilled' && r.value.segments[0] && r.value.frame.w ? { seg: r.value.segments[0], frame: r.value.frame } : undefined;
  };
  const person = first(0), face = first(1), eyes = first(2), mouth = first(3);
  if (person) {
    out.person = boxOf(person.seg.bounds, person.frame);
    out.cutout = await cutoutPng(image, person.seg, person.frame).catch(() => undefined);
  }
  if (face) out.face = boxOf(face.seg.bounds, face.frame);
  if (eyes) out.eyes = boxOf(eyes.seg.bounds, eyes.frame);
  if (mouth) {
    const box = boxOf(mouth.seg.bounds, mouth.frame);
    out.mouth = { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2, w: Math.min(0.6, Math.max(0.02, box.x2 - box.x1)), box };
  }
  return out;
}

/** Text-to-image (used for the neutral library). */
export async function generateImage(prompt: string): Promise<Buffer> {
  const res = await post('/images/generations', {
    model: config.META_IMAGE_MODEL ?? 'muse-image-1.0', prompt, n: 1, size: '1024x1024', output_format: 'jpeg', reasoning_strength: 'low',
  }, 90_000);
  const b64 = (res.data as { b64_json?: string }[] | undefined)?.[0]?.b64_json;
  if (!b64) throw new Error('/images/generations returned no image');
  return Buffer.from(b64, 'base64');
}

export const metaAvatar: AvatarMaker = {
  async stylize(photo, mime, profile) {
    const prompts = STYLE_PRESETS.filter((p) => DEFAULT_STYLES.includes(p.id)).map((p) => withProfile(p.prompt, profile?.gender, profile?.ageRange));
    const results = await Promise.allSettled(prompts.map((prompt) => museEdit(photo, mime, prompt)));
    return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  },

  edit: museEdit,
  analyze: analyzeAvatar,
  generate: (prompt) => generateImage(prompt),

  async findMouth(image, mime) {
    const res = await post('/responses', {
      model: config.META_SAM_MODEL,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'mouth' }, { type: 'input_image', image_url: dataUrl(image, mime) }] }],
    }, 30_000);
    const text = ((res.output ?? []) as { content?: { text?: string }[] }[])
      .flatMap((o) => o.content ?? []).map((c) => c.text ?? '').join('');
    return parseSamBox(text);
  },
};
