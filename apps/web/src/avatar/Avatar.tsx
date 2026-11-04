import { useEffect, useRef } from 'react';

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  imageUrl: string | null;
  mouth?: { x: number; y: number; w: number };
  /** Mouth openness source, 0–1, polled every frame. */
  level: () => number;
  state: AvatarState;
  size?: number;
}

const DEFAULT_MOUTH = { x: 0.5, y: 0.7, w: 0.16 };

/**
 * Canvas avatar with volume-driven lip-sync: the photo (or a drawn silhouette), a mouth that opens
 * with the speech level, idle breathing, and a rim light that reflects the conversation state.
 */
export function Avatar({ imageUrl, mouth = DEFAULT_MOUTH, level, state, size = 320 }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const live = useRef({ level, state, mouth });
  live.current = { level, state, mouth };

  useEffect(() => {
    if (!imageUrl) { img.current = null; return; }
    const i = new Image();
    i.onload = () => { img.current = i; };
    i.src = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    const c = canvas.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = size * dpr;
    c.height = size * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    let open = 0;
    let raf = 0;
    let nextBlink = performance.now() + 2500;

    const draw = (t: number) => {
      const { level, state, mouth } = live.current;
      open += (level() - open) * 0.45; // smooth toward the target
      const bob = Math.sin(t / 1300) * 2.5 + (state === 'speaking' ? Math.sin(t / 210) * 0.8 : 0);
      const breathe = 1 + Math.sin(t / 1900) * 0.006;
      g.clearRect(0, 0, size, size);

      // Rim light ring.
      const ring = state === 'listening' ? 'rgba(158,197,255,0.55)' : state === 'speaking' ? 'rgba(255,255,255,0.35)' : state === 'thinking' ? 'rgba(251,191,36,0.35)' : 'rgba(158,197,255,0.18)';
      const glow = g.createRadialGradient(size / 2, size / 2, size * 0.36, size / 2, size / 2, size * 0.5);
      glow.addColorStop(0, ring);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, size, size);

      g.save();
      g.translate(size / 2, size / 2 + bob);
      g.scale(breathe, breathe);
      g.translate(-size / 2, -size / 2);
      g.beginPath();
      g.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
      g.clip();
      const d = size * 0.84;
      const x0 = (size - d) / 2;

      if (img.current) {
        // object-fit: cover into the circle.
        const i = img.current;
        const s = Math.max(d / i.width, d / i.height);
        const w = i.width * s;
        const h = i.height * s;
        const ix = x0 + (d - w) / 2;
        const iy = x0 + (d - h) / 2;
        g.drawImage(i, ix, iy, w, h);
        drawMouth(g, ix + mouth.x * w, iy + mouth.y * h, mouth.w * w, open);
      } else {
        drawSilhouette(g, size, t >= nextBlink && t < nextBlink + 140, open);
        if (t > nextBlink + 140) nextBlink = t + 2500 + Math.random() * 3500;
      }
      g.restore();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={canvas} style={{ width: size, height: size }} className="max-w-full" aria-label="Your i-person" />;
}

function drawMouth(g: CanvasRenderingContext2D, cx: number, cy: number, w: number, open: number) {
  if (open < 0.04) return;
  const h = w * 0.5 * Math.min(open, 1);
  g.save();
  g.fillStyle = 'rgba(40, 8, 12, 0.92)';
  g.beginPath();
  g.ellipse(cx, cy, w / 2 * (0.85 + 0.15 * open), h / 2, 0, 0, Math.PI * 2);
  g.fill();
  // Hint of teeth and lips so it reads as a mouth at a glance.
  g.fillStyle = 'rgba(240, 235, 230, 0.55)';
  g.fillRect(cx - w * 0.22, cy - h / 2, w * 0.44, Math.max(1, h * 0.18));
  g.strokeStyle = 'rgba(150, 70, 70, 0.6)';
  g.lineWidth = Math.max(1, w * 0.05);
  g.stroke();
  g.restore();
}

function drawSilhouette(g: CanvasRenderingContext2D, size: number, blink: boolean, open: number) {
  const bg = g.createLinearGradient(0, 0, 0, size);
  bg.addColorStop(0, '#1b1e27');
  bg.addColorStop(1, '#07080b');
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);
  const cx = size / 2;
  const head = g.createRadialGradient(cx - size * 0.06, size * 0.36, size * 0.02, cx, size * 0.42, size * 0.22);
  head.addColorStop(0, '#3a3f4d');
  head.addColorStop(1, '#151820');
  g.fillStyle = head;
  g.beginPath();
  g.ellipse(cx, size * 0.42, size * 0.16, size * 0.2, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(cx, size * 0.92, size * 0.32, size * 0.26, 0, Math.PI, 0);
  g.fill();
  g.fillStyle = '#d7e6ff';
  for (const dx of [-0.055, 0.055]) {
    g.beginPath();
    g.ellipse(cx + dx * size, size * 0.4, size * 0.014, blink ? 1 : size * 0.016, 0, 0, Math.PI * 2);
    g.fill();
  }
  if (open < 0.04) {
    g.strokeStyle = '#9aa3b5';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx - size * 0.035, size * 0.5);
    g.lineTo(cx + size * 0.035, size * 0.5);
    g.stroke();
  } else drawMouth(g, cx, size * 0.5, size * 0.08, open);
}
