// Fallback speech recognition in the browser (Chrome, Edge, Safari) while server STT is unavailable.

interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

const Ctor = (globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition })
  .SpeechRecognition ?? (globalThis as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

export const browserSttSupported = Boolean(Ctor);

export const LANG_TAG: Record<string, string> = { en: 'en-US', fr: 'fr-FR', ar: 'ar-TN' };

export function listen(lang: string, h: { onPartial(t: string): void; onFinal(t: string): void; onEnd(): void; onError(e: string): void }) {
  if (!Ctor) throw new Error('Speech recognition is not supported in this browser');
  const r = new Ctor();
  r.lang = LANG_TAG[lang] ?? lang;
  r.continuous = false;
  r.interimResults = true;
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i]!;
      if (res.isFinal) h.onFinal(res[0].transcript);
      else h.onPartial(res[0].transcript);
    }
  };
  r.onend = () => h.onEnd();
  r.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') h.onError(e.error); };
  r.start();
  return { stop: () => r.stop(), abort: () => r.abort() };
}
