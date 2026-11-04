import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';

// Background scenes behind the avatar's cut-out (A4). Presets are Pexels photos, downloaded once and
// served from our domain (shared files `scene-<id>.jpg`), with the photographer credited.

export const SCENE_PRESETS = [
  { id: 'studio', label: 'Studio', query: null },
  { id: 'office', label: 'Office', query: 'bright modern office interior empty' },
  { id: 'cafe', label: 'Café', query: 'cozy cafe interior empty' },
  { id: 'beach', label: 'Beach', query: 'tropical beach sea horizon' },
  { id: 'city', label: 'City at night', query: 'city skyline at night bokeh' },
] as const;
export type ScenePreset = (typeof SCENE_PRESETS)[number]['id'];

export interface Scene { id: string; url: string | null; credit?: string; credit_url?: string }

/** The preset's photo, fetched from Pexels the first time (square-ish, 1024+). */
export async function presetScene(id: ScenePreset): Promise<Scene> {
  const preset = SCENE_PRESETS.find((p) => p.id === id)!;
  if (!preset.query) return { id, url: null };
  const meta = join(config.UPLOAD_DIR, `scene-${id}.json`);
  const cached = await readFile(meta, 'utf8').then((t) => JSON.parse(t) as Scene).catch(() => null);
  if (cached) return cached;
  if (!config.PEXELS_API_KEY) throw new Error('PEXELS_API_KEY is not set');
  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(preset.query)}&per_page=5&orientation=square`, {
    headers: { Authorization: config.PEXELS_API_KEY }, signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Pexels ${res.status}`);
  const photo = ((await res.json()) as { photos: { photographer: string; url: string; src: { large2x: string } }[] }).photos[0];
  if (!photo) throw new Error('Pexels found nothing');
  const img = await fetch(photo.src.large2x, { signal: AbortSignal.timeout(20_000) });
  if (!img.ok) throw new Error(`Pexels image ${img.status}`);
  await writeFile(join(config.UPLOAD_DIR, `scene-${id}.jpg`), Buffer.from(await img.arrayBuffer()));
  const scene: Scene = { id, url: `/api/media/scene-${id}.jpg`, credit: `${photo.photographer} / Pexels`, credit_url: photo.url };
  await writeFile(meta, JSON.stringify(scene));
  return scene;
}

/** Free-text scene, made with Muse Image (charged): a backdrop with no people in it. */
export const scenePrompt = (description: string) =>
  `A background scene: ${description.trim()}. No people, no text, eye-level view, soft depth of field, suitable as a backdrop behind a person standing in front.`;
