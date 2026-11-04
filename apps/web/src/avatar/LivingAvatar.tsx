import { useEffect, useRef, useState } from 'react';
import { Application, Assets, Container, Graphics, Mesh, PlaneGeometry, Sprite, Texture } from 'pixi.js';
import { Avatar, type AvatarState } from './Avatar.tsx';
import type { Frame, Pose } from './behaviour.ts';

// The living avatar (A2): a 2.5D mesh rig in PixiJS. The person (cut-out when available) is a
// deformable plane: it breathes, sways, turns its head toward the gaze target, nods, and lip-syncs.
// Pose variants cross-fade; blinks use the `blink` variant on the eyes or drawn eyelids.

type Box = { x1: number; y1: number; x2: number; y2: number };
export interface RigVariant { url: string; cutout_url?: string; masks: { face?: Box; eyes?: Box; person?: Box; mouth?: { x: number; y: number; w: number; box?: Box } } }
export interface Rig { variants: Partial<Record<Pose, RigVariant>> & { base?: RigVariant }; alive: boolean }

interface Props {
  rig: Rig | null;
  /** Mouth openness 0–1, polled every frame. */
  level: () => number;
  /** Behaviour frame for "now" (pose, gaze, nod, celebrate), polled every frame. */
  behaviour: () => Frame;
  state: AvatarState;
  size: number;
  /** Background scene behind the cut-out (A4). */
  sceneUrl?: string | null;
  onTap?: () => void;
  onLongPress?: () => void;
}

const L = 1000; // logical canvas units; the stage is scaled to `size`
const GRID = 24;
const FADE_MS = 200;
const DEFAULT_FACE: Box = { x1: 0.36, y1: 0.12, x2: 0.64, y2: 0.5 };

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
/** Smooth noise from incommensurate sines: never perfectly periodic. */
const noise = (t: number, seed: number) => (Math.sin(t * 0.61 + seed) + Math.sin(t * 1.37 + seed * 2.1) * 0.5 + Math.sin(t * 0.23 + seed * 0.7) * 0.8) / 2.3;

interface Layer { mesh: Mesh<PlaneGeometry>; rest: Float32Array; variant: RigVariant; pose: Pose }

export function LivingAvatar(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const [failed, setFailed] = useState(false);
  const base = props.rig?.variants.base;

  useEffect(() => {
    if (!base || failed) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const app = new Application();
    let destroyed = false;
    let cleanup = () => {};

    (async () => {
      await app.init({ width: props.size, height: props.size, backgroundAlpha: 0, antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true, preference: 'webgl' });
      if (destroyed) return app.destroy(true);
      host.current!.appendChild(app.canvas);
      app.canvas.setAttribute('aria-label', 'Your i-person');
      app.canvas.style.touchAction = 'none';
      app.stage.scale.set(props.size / L);

      const variants = live.current.rig!.variants;
      const useCutout = Boolean(variants.base?.cutout_url);
      const textures = new Map<Pose, Texture>();
      await Promise.all(Object.entries(variants).map(async ([pose, v]) => {
        if (!v) return;
        const tex = await Assets.load<Texture>({ src: (useCutout && v.cutout_url) || v.url, loadParser: 'loadTextures' }).catch(() => null);
        if (tex) textures.set(pose as Pose, tex);
      }));
      if (destroyed) return;
      if (!textures.has('base')) { setFailed(true); return; }

      // Scene (only behind a cut-out; a plain image has its own background).
      const scene = new Container();
      app.stage.addChild(scene);
      let sceneSprite: Sprite | null = null;
      const setScene = async (url?: string | null) => {
        sceneSprite?.destroy();
        sceneSprite = null;
        if (!url || !useCutout) return;
        const tex = await Assets.load<Texture>({ src: url, loadParser: 'loadTextures' }).catch(() => null);
        if (!tex || destroyed) return;
        sceneSprite = new Sprite(tex);
        const s = Math.max(L / tex.width, L / tex.height); // cover
        sceneSprite.scale.set(s);
        sceneSprite.position.set((L - tex.width * s) / 2, (L - tex.height * s) / 2);
        scene.addChild(sceneSprite);
      };
      let sceneUrl = live.current.sceneUrl;
      void setScene(sceneUrl);

      // One deformable plane per pose; only the current (and the fading-out one) are visible.
      const people = new Container();
      app.stage.addChild(people);
      const layers = new Map<Pose, Layer>();
      for (const [pose, tex] of textures) {
        const geometry = new PlaneGeometry({ width: L, height: L, verticesX: GRID, verticesY: GRID });
        const mesh = new Mesh({ geometry, texture: tex });
        mesh.alpha = pose === 'base' ? 1 : 0;
        mesh.visible = pose === 'base';
        people.addChild(mesh);
        layers.set(pose, { mesh, rest: new Float32Array(geometry.positions), variant: variants[pose]!, pose });
      }

      // Eyelids for blinks when there's no `blink` variant: skin colour sampled just above the eyes.
      const lids = new Graphics();
      const mouthG = new Graphics();
      const fx = new Graphics();
      app.stage.addChild(lids, mouthG, fx);
      const skin = await sampleColor(variants.base!.url, variants.base!.masks.eyes);

      let current: Pose = 'base';
      let previous: Pose | null = null;
      let fadeStart = 0;
      let nextBlink = performance.now() + 1500 + Math.random() * 2500;
      let blinkUntil = 0;
      let doubleBlink = false;
      let open = 0;
      let nodPhase = 0;
      let celebrateStart = 0;
      const pointer = { x: 0, y: 0, active: false, strong: false };

      // Pointer gaze (desktop drag = stronger), tap and long-press.
      let pressTimer: ReturnType<typeof setTimeout> | undefined;
      let longPressed = false;
      app.stage.eventMode = 'static';
      app.stage.hitArea = { contains: () => true };
      const onMove = (e: PointerEvent) => {
        const r = app.canvas.getBoundingClientRect();
        pointer.x = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
        pointer.y = clamp(((e.clientY - r.top) / r.height - 0.4) * 2, -1, 1);
        pointer.active = true;
      };
      const onLeave = () => { pointer.active = false; pointer.strong = false; };
      const onDown = (e: PointerEvent) => {
        onMove(e);
        pointer.strong = e.pointerType === 'mouse';
        longPressed = false;
        pressTimer = setTimeout(() => { longPressed = true; live.current.onLongPress?.(); }, 600);
      };
      const onUp = () => {
        clearTimeout(pressTimer);
        pointer.strong = false;
        if (!longPressed) live.current.onTap?.();
      };
      app.canvas.addEventListener('pointermove', onMove);
      app.canvas.addEventListener('pointerleave', onLeave);
      app.canvas.addEventListener('pointerdown', onDown);
      app.canvas.addEventListener('pointerup', onUp);

      const onVisibility = () => (document.hidden ? app.ticker.stop() : app.ticker.start());
      document.addEventListener('visibilitychange', onVisibility);

      // Read by the headless smoke test (A5): blinks, lip-sync, frame rate, current pose.
      const stats = { blinks: 0, maxOpen: 0, fps: 0, pose: 'base' as Pose, layers: [...layers.keys()] };
      (window as unknown as { __avatar?: typeof stats }).__avatar = stats;
      let frames = 0;
      let fpsSince = performance.now();
      app.ticker.add(() => {
        const now = performance.now();
        const t = now / 1000;
        const p = live.current;
        if (p.sceneUrl !== sceneUrl) { sceneUrl = p.sceneUrl; void setScene(sceneUrl); }
        const b = p.behaviour();

        // Pose: cross-fade to the requested variant when we have it (reduced motion: base only).
        const want: Pose = reduced ? 'base' : layers.has(b.pose) && b.pose !== 'blink' ? b.pose : 'base';
        if (want !== current) {
          previous = current;
          current = want;
          fadeStart = now;
          layers.get(current)!.mesh.visible = true;
        }
        const k = clamp((now - fadeStart) / FADE_MS);
        for (const [pose, layer] of layers) {
          if (pose === 'blink') continue;
          layer.mesh.alpha = pose === current ? k : pose === previous ? 1 - k : 0;
          layer.mesh.visible = layer.mesh.alpha > 0.001;
        }
        if (k >= 1) previous = null;

        // Motion parameters.
        open += (p.level() - open) * 0.45;
        const speaking = p.state === 'speaking';
        if (b.nod || (speaking && open > 0.5 && Math.random() < 0.02)) nodPhase = Math.max(nodPhase, 1);
        nodPhase = Math.max(0, nodPhase - 0.045);
        const nod = Math.sin((1 - nodPhase) * Math.PI) * (nodPhase > 0 ? 1 : 0);
        const gx = pointer.active ? pointer.x * (pointer.strong ? 1 : 0.5) : b.gaze.x;
        const gy = pointer.active ? pointer.y * (pointer.strong ? 1 : 0.5) : b.gaze.y;
        const motion = reduced ? 0 : 1;
        const m = {
          breath: (Math.sin((t * 2 * Math.PI) / 4.2) + 1) / 2 * motion,
          swayX: noise(t * 0.5, 1) * motion,
          swayR: noise(t * 0.4, 7) * motion,
          gx: gx * motion, gy: gy * motion,
          nod: nod * motion,
          talk: speaking ? (noise(t * 2.2, 3) * 0.6 + open * 0.4) * motion : 0,
        };

        for (const layer of layers.values()) if (layer.mesh.visible) deform(layer, m);

        // Blink: every 2.5–6 s, sometimes double.
        if (now >= nextBlink) {
          stats.blinks++;
          blinkUntil = now + 130;
          nextBlink = doubleBlink ? now + 260 : now + 2500 + Math.random() * 3500;
          doubleBlink = !doubleBlink && Math.random() < 0.2;
        }
        const blinking = now < blinkUntil;
        const blinkLayer = layers.get('blink');
        const eyes = layers.get(current)!.variant.masks.eyes ?? variants.base!.masks.eyes;
        lids.clear();
        if (blinkLayer) {
          blinkLayer.mesh.visible = blinking && current === 'base';
          blinkLayer.mesh.alpha = 1;
          if (blinkLayer.mesh.visible) deform(blinkLayer, m);
        }
        if (blinking && (!blinkLayer || current !== 'base') && eyes && skin) {
          // Drawn eyelids over each eye half, following the head.
          const c = point(layers.get(current)!, (eyes.x1 + eyes.x2) / 2, (eyes.y1 + eyes.y2) / 2, m);
          const w = (eyes.x2 - eyes.x1) * L;
          const h = (eyes.y2 - eyes.y1) * L;
          // Fallback only (no `blink` image): a lid shaped to each eye, shaded, with a lash curve.
          for (const side of [-1, 1]) {
            const ex = c.x + side * w * 0.25;
            const rw = w * 0.15;
            const rh = h * 0.36;
            lids.ellipse(ex, c.y, rw, rh).fill({ color: skin, alpha: 0.97 });
            lids.ellipse(ex, c.y - rh * 0.35, rw * 0.95, rh * 0.55).fill({ color: shade(skin, 0.92), alpha: 0.6 });
            lids.moveTo(ex - rw, c.y + rh * 0.1).quadraticCurveTo(ex, c.y + rh * 0.75, ex + rw, c.y + rh * 0.1)
              .stroke({ width: Math.max(2, h * 0.07), color: 0x2a1a14, alpha: 0.75, cap: 'round' });
          }
        }

        // Lip-sync on the current pose's mouth.
        mouthG.clear();
        const mouth = layers.get(current)!.variant.masks.mouth ?? variants.base!.masks.mouth;
        stats.maxOpen = Math.max(stats.maxOpen, open);
        stats.pose = current;
        if (mouth && open > 0.04) {
          const c = point(layers.get(current)!, mouth.x, mouth.y, m);
          drawMouth(mouthG, c.x, c.y, mouth.w * L * 0.72, Math.min(open, 1));
        }

        // Celebration: a short burst of confetti.
        if (b.celebrate && !celebrateStart) celebrateStart = now;
        fx.clear();
        if (celebrateStart) {
          const e = (now - celebrateStart) / 1200;
          if (e > 1) celebrateStart = b.celebrate ? celebrateStart : 0;
          else for (let i = 0; i < 28; i++) {
            const a = (i / 28) * Math.PI * 2;
            const r = 120 + e * 380;
            fx.circle(L / 2 + Math.cos(a) * r, 380 + Math.sin(a) * r * 0.7 + e * e * 200, 7 * (1 - e)).fill({ color: [0xfbbf24, 0x60a5fa, 0x34d399, 0xf472b6][i % 4]!, alpha: 1 - e });
          }
        }

        frames++;
        if (now - fpsSince > 2000) {
          stats.fps = Math.round((frames * 1000) / (now - fpsSince));
          frames = 0;
          fpsSince = now;
        }
      });

      cleanup = () => {
        document.removeEventListener('visibilitychange', onVisibility);
        app.canvas.removeEventListener('pointermove', onMove);
        app.canvas.removeEventListener('pointerleave', onLeave);
        app.canvas.removeEventListener('pointerdown', onDown);
        app.canvas.removeEventListener('pointerup', onUp);
        clearTimeout(pressTimer);
      };
    })().catch(() => setFailed(true));

    return () => {
      destroyed = true;
      cleanup();
      try { app.destroy(true, { children: true }); } catch { /* not initialised yet */ }
    };
    // Rebuild when the look changes, not on every prop change (props are read live).
  }, [base?.url, base?.cutout_url, props.size, failed, Object.keys(props.rig?.variants ?? {}).join()]);

  if (!base || failed) {
    return <Avatar imageUrl={base?.url ?? null} mouth={base?.masks.mouth} level={props.level} state={props.state} size={props.size} />;
  }
  return <div ref={host} style={{ width: props.size, height: props.size }} className="relative max-w-full overflow-hidden rounded-3xl" data-living-avatar="" />;
}

interface Motion { breath: number; swayX: number; swayR: number; gx: number; gy: number; nod: number; talk: number }

/** Where a rest point (0–1) ends up after this frame's deformation (for the mouth and eyelids). */
function point(layer: Layer, u: number, v: number, m: Motion) {
  const out = new Float32Array(2);
  displace(layer.variant.masks.face ?? DEFAULT_FACE, u * L, v * L, m, out);
  return { x: out[0]!, y: out[1]! };
}

function deform(layer: Layer, m: Motion) {
  const pos = layer.mesh.geometry.positions;
  const face = layer.variant.masks.face ?? DEFAULT_FACE;
  const out = new Float32Array(2);
  for (let i = 0; i < pos.length; i += 2) {
    displace(face, layer.rest[i]!, layer.rest[i + 1]!, m, out);
    pos[i] = out[0]!;
    pos[i + 1] = out[1]!;
  }
  layer.mesh.geometry.getBuffer('aPosition').update();
}

/**
 * The rig: the bottom edge is fixed; everything above the neck rises with the breath; the head
 * (weighted by distance from the face box) turns around the neck toward the gaze, nods and sways.
 */
function displace(face: Box, x: number, y: number, m: Motion, out: Float32Array) {
  const u = x / L;
  const v = y / L;
  const neckV = face.y2 + 0.04;
  const fcx = (face.x1 + face.x2) / 2;
  const fw = face.x2 - face.x1;
  // Head weight: 1 on the face and hair, fading out across the neck.
  const head = (1 - smooth(neckV - 0.02, neckV + 0.08, v)) * (1 - smooth(fw * 0.9, fw * 1.6, Math.abs(u - fcx)));
  // Chest weight for breathing: grows from the bottom edge up to the neck.
  const lift = clamp((1 - v) / (1 - neckV + 1e-6));

  let dx = m.swayX * 3 * lift + (u - 0.5) * m.breath * 0.006 * L * (1 - head) * (1 - smooth(0.9, 1, v));
  let dy = -m.breath * 5 * lift;

  // Head: rotate around the neck pivot, then shift toward the gaze, nod and talk.
  const angle = (m.swayR * 0.018 + m.gx * 0.03 + m.talk * 0.012) * head;
  const px = fcx * L;
  const py = neckV * L;
  const rx = x - px;
  const ry = y - py;
  dx += rx * Math.cos(angle) - ry * Math.sin(angle) - rx;
  dy += rx * Math.sin(angle) + ry * Math.cos(angle) - ry;
  dx += m.gx * 7 * head;
  dy += (m.gy * 4 + m.nod * 9 + m.talk * 2) * head;

  out[0] = x + dx;
  out[1] = y + dy;
}

function drawMouth(g: Graphics, cx: number, cy: number, w: number, open: number) {
  const h = w * 0.42 * open;
  g.ellipse(cx, cy, (w / 2) * (0.85 + 0.15 * open), h / 2).fill({ color: 0x3a0f14, alpha: 0.85 }).stroke({ width: Math.max(2, w * 0.05), color: 0x964646, alpha: 0.6 });
  g.rect(cx - w * 0.22, cy - h / 2, w * 0.44, Math.max(2, h * 0.18)).fill({ color: 0xf0ebe6, alpha: 0.55 });
}

/** Darker version of a 0xRRGGBB colour. */
const shade = (c: number, f: number) => (Math.round(((c >> 16) & 255) * f) << 16) | (Math.round(((c >> 8) & 255) * f) << 8) | Math.round((c & 255) * f);

/** Average colour of a small patch just above the eyes (for drawn eyelids). */
async function sampleColor(url: string, eyes?: Box): Promise<number | null> {
  if (!eyes) return null;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 4;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    const sx = ((eyes.x1 + eyes.x2) / 2) * img.width - 0.03 * img.width;
    const sy = (eyes.y1 - 0.025) * img.height;
    g.drawImage(img, sx, sy, 0.06 * img.width, 0.02 * img.height, 0, 0, 8, 4);
    const d = g.getImageData(0, 0, 8, 4).data;
    let r = 0, gr = 0, bl = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]!; gr += d[i + 1]!; bl += d[i + 2]!; }
    const n = d.length / 4;
    return (Math.round(r / n) << 16) | (Math.round(gr / n) << 8) | Math.round(bl / n);
  } catch {
    return null;
  }
}
