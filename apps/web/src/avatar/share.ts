import type { Rig } from './LivingAvatar.tsx';

const W = 1080;
const H = 1350;

const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const i = new Image();
  i.onload = () => resolve(i);
  i.onerror = reject;
  i.src = src;
});

/** "Share my twin": a 1080×1350 card — the avatar in its scene, name, link and logo. Made in the browser. */
export async function shareCard(rig: Rig, sceneUrl: string | null | undefined, name: string): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const base = rig.variants.smile ?? rig.variants.base!;

  // Scene (cover) behind a cut-out; otherwise a dark gradient.
  if (sceneUrl && base.cutout_url) {
    const bg = await load(sceneUrl);
    const s = Math.max(W / bg.width, H / bg.height);
    g.drawImage(bg, (W - bg.width * s) / 2, (H - bg.height * s) / 2, bg.width * s, bg.height * s);
  } else {
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1b1e27');
    grad.addColorStop(1, '#050608');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
  }
  const person = await load(base.cutout_url ?? base.url);
  const size = W * 0.92;
  g.drawImage(person, (W - size) / 2, H - size - 170, size, size);

  // Bottom band: name, link, logo.
  const band = g.createLinearGradient(0, H - 300, 0, H);
  band.addColorStop(0, 'rgba(0,0,0,0)');
  band.addColorStop(0.45, 'rgba(0,0,0,0.85)');
  band.addColorStop(1, 'rgba(0,0,0,0.95)');
  g.fillStyle = band;
  g.fillRect(0, H - 300, W, 300);
  g.fillStyle = '#fff';
  g.font = '600 64px system-ui, -apple-system, Segoe UI, sans-serif';
  g.fillText(name, 72, H - 120);
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.font = '400 38px system-ui, -apple-system, Segoe UI, sans-serif';
  // HACKATHON: the public @handle page (Phase 6) isn't built yet; the card links the site.
  g.fillText('Meet my twin at i-persons.com', 72, H - 60);
  const logo = await load('/favicon.svg').catch(() => null);
  if (logo) g.drawImage(logo, W - 72 - 96, H - 170, 96, 96);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas'))), 'image/png'));
}

/** Native share sheet with the image when the browser can; otherwise a download. */
export async function shareOrDownload(blob: Blob, name: string) {
  const file = new File([blob], 'my-i-person.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: name, text: 'Meet my twin on i-persons.com' }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'my-i-person.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
