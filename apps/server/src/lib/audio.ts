import { spawn } from 'node:child_process';

/** Any audio (WhatsApp OGG voice notes) → 16 kHz mono 16-bit WAV, via ffmpeg. */
export function toWav16k(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-f', 'wav', 'pipe:1']);
    const out: Buffer[] = [];
    let err = '';
    ff.stdout.on('data', (d: Buffer) => out.push(d));
    ff.stderr.on('data', (d: Buffer) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 300)}`))));
    ff.stdin.end(input);
  });
}
