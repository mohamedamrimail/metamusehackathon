// Mic capture → 16 kHz mono PCM16 frames of 20 ms (SPEC: Hearing). The worklet is inlined as a Blob.

const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.pos = 0; this.out = new Int16Array(320); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Linear-interpolation resample to 16 kHz.
    for (; this.pos < ch.length; this.pos += this.ratio) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const s = (ch[i] ?? 0) * (1 - f) + (ch[i + 1] ?? ch[i] ?? 0) * f;
      this.out[this.n++] = Math.max(-1, Math.min(1, s)) * 0x7fff;
      if (this.n === 320) { this.port.postMessage(this.out.buffer.slice(0)); this.n = 0; }
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor('pcm16', Pcm16);
`;

export interface Mic {
  stop(): void;
  /** Input loudness 0–1, for the listening indicator. */
  level(): number;
}

export async function startMic(onFrame: (pcm: ArrayBuffer) => void): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm16');
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  node.port.onmessage = (e) => onFrame(e.data as ArrayBuffer);
  src.connect(node);
  src.connect(analyser);
  // A browser may create the context suspended (no click yet): resume now, and again on the user's next tap or key.
  const wake = () => { if (ctx.state === 'suspended') void ctx.resume(); };
  wake();
  const events = ['pointerdown', 'keydown', 'touchstart'] as const;
  for (const e of events) window.addEventListener(e, wake, { passive: true });
  const buf = new Float32Array(analyser.fftSize);
  return {
    stop() {
      for (const e of events) window.removeEventListener(e, wake);
      node.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
    level() {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.min(1, Math.sqrt(sum / buf.length) * 6);
    },
  };
}
