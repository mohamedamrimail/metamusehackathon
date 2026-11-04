// The agent's mood tag: Muse Spark starts each reply with "[mood:happy]"; the runtime strips it
// (never spoken, never stored) and the avatar uses it to pick a pose.

export const MOODS = ['neutral', 'happy', 'thinking', 'surprised', 'sorry'] as const;
export type Mood = (typeof MOODS)[number];

/** "[mood:happy] Sure!" → { mood: 'happy', text: 'Sure!' }. Removes every tag, wherever it is. */
export function splitMood(text: string): { mood?: Mood; text: string } {
  const m = /\[mood:\s*(neutral|happy|thinking|surprised|sorry)\s*\]/i.exec(text);
  return { mood: m?.[1]?.toLowerCase() as Mood | undefined, text: text.replace(/\s*\[mood:[^\]]*\]\s*/gi, ' ').trim() };
}

/** What the voice says: no web addresses (the site is named instead) and no markdown symbols. */
export function speakable(text: string): string {
  return text
    .replace(/\(?\s*(?:https?:\/\/|www\.)[^\s)]*[^\s).,;!?]\)?/gi, ' ')
    .replace(/\s+[-–—]\s*(?=[\s.,;]|$)/g, '')
    .replace(/[*_#`>]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

/** What the twin says when its avatar is tapped (spoken in its own voice; the server caches the audio). */
export const TAP_LINES: Record<string, string[]> = {
  en: ['Hey! I’m here.', 'That tickles!', 'What can I do for you?'],
  fr: ['Coucou ! Je suis là.', 'Ça chatouille !', 'Je peux t’aider ?'],
  ar: ['أهلاً! أنا هنا.', 'هذا يدغدغ!', 'كيف أساعدك؟'],
};
