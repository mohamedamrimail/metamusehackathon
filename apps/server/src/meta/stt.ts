import { clip, timedMeta } from '../lib/call-log.ts';
import WebSocket from 'ws';
import { config } from '../config.ts';

// Muse Voice Transcribe, realtime. Browser PCM16 16 kHz mono frames are relayed as-is.

export interface SttStream {
  write(pcm: Buffer): void;
  /** Push-to-talk release: flush and finalize the current utterance. */
  commit(): void;
  close(): void;
}

export interface SttHandlers {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(err: Error): void;
}

export type SttFactory = (opts: { language: string }, handlers: SttHandlers) => SttStream;

const MODEL = 'muse-voice-transcribe-1.0';
/** languageBias takes language names; it's a hint, not a forced language (Derja still comes through). */
const LANGUAGE_NAMES: Record<string, string> = { en: 'English', fr: 'French', ar: 'Arabic' };
const languageBias = (code: string) => [LANGUAGE_NAMES[code.slice(0, 2)] ?? 'English'];

/**
 * One push-to-talk utterance = one realtime session (protocol: dev.meta.ai/docs/speech-to-text).
 * Auth rides in the first JSON frame (the Authorization header is ignored); audio is raw PCM16
 * 16 kHz mono binary frames at real-time pace; `endStream` flushes, the server sends the final
 * `transcript` and closes with 1000. The caller opens a new stream for the next utterance.
 */
export const metaRealtimeStt: SttFactory = ({ language }, h) => {
  const ws = new WebSocket(config.META_STT_WS);
  const queue: Buffer[] = [];
  let ready = false;
  let ending = false;
  let finished = false;

  const end = () => {
    ws.send(JSON.stringify({ type: 'endStream' }));
  };

  ws.on('open', () => {
    ws.send(JSON.stringify({
      authorization: { accessToken: `Bearer ${config.META_API_KEY}` },
      model: MODEL,
      audioEncoding: 'PCM_16KHZ',
      mode: 'PUSH_TO_TALK',
      partialMode: 'CUMULATIVE',
      emitAudioProgress: false,
      languageBias: languageBias(language),
    }));
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString()) as { type?: string; transcript?: string; final?: boolean; message?: string; sessionId?: string };
      if (!msg.type && msg.sessionId) {
        // Handshake acknowledged: flush what the mic sent meanwhile.
        ready = true;
        for (const b of queue.splice(0)) ws.send(b);
        if (ending) end();
      } else if (msg.type === 'error') {
        finished = true;
        h.onError(new Error(msg.message ?? 'stt error'));
      } else if (msg.type === 'transcript') {
        if (msg.final) {
          finished = true;
          h.onFinal(msg.transcript ?? '');
        } else {
          h.onPartial(msg.transcript ?? '');
        }
      }
    } catch (err) {
      h.onError(err as Error);
    }
  });
  ws.on('close', (code) => {
    if (finished) return;
    if (code === 1013) h.onError(new Error('speech recognition is busy (rate limit)'));
    else if (ending) h.onFinal(''); // ended without speech
  });
  ws.on('error', (err) => {
    finished = true;
    h.onError(err);
  });

  return {
    write(pcm) {
      if (ending) return;
      if (ready) ws.send(pcm);
      else if (queue.length < 500) queue.push(pcm); // ~10 s of 20 ms frames
    },
    commit() {
      if (ending) return;
      ending = true;
      if (ready) end();
    },
    close() {
      finished = true;
      ws.close();
    },
  };
};

/** Whole-file transcription (WhatsApp voice notes): mono 16-bit WAV at 16/24 kHz, ≤10 min, ≤32 MB. */
export async function transcribeWav(wav: Buffer, language: string): Promise<{ text: string; seconds: number }> {
  return timedMeta('Muse Voice Transcribe', (r) => `voice note (${r.seconds.toFixed(1)} s) → "${clip(r.text, 60)}"`, () => transcribeWavRaw(wav, language));
}

async function transcribeWavRaw(wav: Buffer, language: string): Promise<{ text: string; seconds: number }> {
  if (!config.META_API_KEY) throw new Error('META_API_KEY is not set');
  const form = new FormData();
  const request = { model: MODEL, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK', languageBias: languageBias(language) };
  form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
  form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
  const res = await fetch(config.META_STT_HTTP, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.META_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as { transcript?: string; audioDurationMs?: number; error?: { message?: string } };
  if (!res.ok) throw new Error(`transcribe failed: HTTP ${res.status} ${data.error?.message ?? ''}`.trim());
  return { text: data.transcript ?? '', seconds: (data.audioDurationMs ?? 0) / 1000 };
}
