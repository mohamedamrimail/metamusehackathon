import { speakable } from '@ipersons/shared';

// The i-person's voice: the browser's built-in window.speechSynthesis (an OS/browser feature, not an AI model
// call). It picks a voice for the reply's language (en, fr, de, ar), falling back to the default voice. Without
// speechSynthesis the reply is shown as text only. The mouth level for lip-sync is synthesized from the
// utterance's word-boundary events, since speechSynthesis exposes no audio stream.

const LANG_TAG: Record<string, string> = { en: 'en-US', fr: 'fr-FR', de: 'de-DE', ar: 'ar-SA' };

const STOP_WORDS: Record<'en' | 'fr' | 'de', RegExp> = {
  en: /\b(the|and|you|your|is|are|to|of|for|with|it|this|that|i'm|i'll|on|at)\b/gi,
  fr: /\b(le|la|les|et|vous|tu|est|sont|de|des|du|pour|avec|je|un|une|c'est|à|ça|pas)\b/gi,
  de: /\b(der|die|das|und|ist|sind|ich|du|sie|nicht|mit|für|ein|eine|zu|auf|dein|ihr|es)\b/gi,
};

/** The reply's language: Arabic script → ar; otherwise the best stop-word match among en/fr/de, else the user's locale. */
export function replyLanguage(text: string, fallback: string): string {
  if (/[؀-ۿ]/.test(text)) return 'ar';
  const scores = (Object.keys(STOP_WORDS) as (keyof typeof STOP_WORDS)[])
    .map((l) => [l, text.match(STOP_WORDS[l])?.length ?? 0] as const)
    .sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (best && best[1] >= 2 && best[1] > (second?.[1] ?? 0)) return best[0];
  return fallback.slice(0, 2);
}

const supported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

/** A voice for the language: a natural/premium one if the OS has it, any voice of that language, else none (default). */
function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const base = lang.slice(0, 2).toLowerCase();
  const ofLang = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(base));
  return ofLang.find((v) => v.lang === LANG_TAG[base] && /natural|premium|enhanced|neural|google/i.test(v.name))
    ?? ofLang.find((v) => /natural|premium|enhanced|neural|google/i.test(v.name))
    ?? ofLang.find((v) => v.lang === LANG_TAG[base])
    ?? ofLang[0];
}

export class Speaker {
  private synthUntil = 0;
  private synthActive = false;
  onSpeakingChange?: (speaking: boolean) => void;

  constructor() {
    // Some browsers load the voice list late; asking once warms it up.
    if (supported()) window.speechSynthesis.getVoices();
  }

  /** Call from a user gesture (first tap): iOS only allows speech after one. */
  unlock() {
    if (supported()) window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  }

  /** Speaks the text in its own language (detected; `lang` is the user's locale as the fallback). */
  speakText(text: string, lang: string) {
    if (!supported()) return; // text-only: the reply is already on screen
    this.stop();
    const clean = speakable(text);
    if (!clean.trim()) return;
    const u = new SpeechSynthesisUtterance(clean);
    const l = replyLanguage(clean, lang);
    u.lang = LANG_TAG[l] ?? l;
    const voice = pickVoice(l);
    if (voice) u.voice = voice;
    u.onstart = () => { this.synthActive = true; this.synthUntil = performance.now() + 250; this.onSpeakingChange?.(true); };
    u.onboundary = () => { this.synthUntil = performance.now() + 260; };
    u.onend = u.onerror = () => { this.synthActive = false; this.onSpeakingChange?.(false); };
    window.speechSynthesis.speak(u);
  }

  /** Barge-in: stop whatever is being said. */
  stop() {
    if (!supported()) return;
    window.speechSynthesis.cancel();
    if (this.synthActive) {
      this.synthActive = false;
      this.onSpeakingChange?.(false);
    }
  }

  get speaking() {
    return this.synthActive;
  }

  level(now = performance.now()): number {
    if (this.synthActive && now < this.synthUntil) {
      // Syllable-like flapping while a word is being spoken.
      return 0.35 + 0.35 * Math.abs(Math.sin(now / 70)) * (0.6 + 0.4 * Math.sin(now / 190));
    }
    return 0;
  }
}
