import { useEffect, useState } from 'react';
import { api } from '../api.ts';

// Jury §7: "How useful is your i-person?" (1–5), one optional line, and permission to quote the first name.

export function FeedbackForm({ context, onDone }: { context: 'talk' | 'twin'; onDone(): void }) {
  const [rating, setRating] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [quotable, setQuotable] = useState(false);
  const [sent, setSent] = useState(false);
  const send = async (dismiss = false) => {
    await api('/me/feedback', { body: dismiss ? { rating: null, context } : { rating, text: text.trim() || undefined, quotable, context } }).catch(() => {});
    setSent(true);
    onDone();
  };
  if (sent) return <p className="text-sm text-muted">Thank you!</p>;
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium">How useful is your i-person?</p>
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} of 5`}
            className={`h-9 w-9 rounded-full border ${rating !== null && n <= rating ? 'border-rim bg-rim/20 text-rim' : 'border-line text-muted'}`}>{n}</button>
        ))}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={500} placeholder="Anything you’d tell a friend about it?"
        className="w-full rounded-xl border border-line bg-ink px-3 py-2 outline-none focus:border-rim/60" />
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={quotable} onChange={(e) => setQuotable(e.target.checked)} /> You may quote me with my first name
      </label>
      <div className="flex gap-2">
        {context === 'talk' && <button type="button" onClick={() => void send(true)} className="flex-1 rounded-full border border-line py-2">Not now</button>}
        <button type="button" disabled={rating === null} onClick={() => void send()} className="flex-1 rounded-full bg-white py-2 font-medium text-black disabled:opacity-40">Send</button>
      </div>
    </div>
  );
}

/** Talk: asked once, after the user's 5th turn. */
export function FeedbackPrompt({ turns }: { turns: number }) {
  const [due, setDue] = useState(false);
  useEffect(() => {
    if (turns < 5) return;
    api<{ due: boolean }>('/me/feedback/status').then((r) => setDue(r.due)).catch(() => {});
  }, [turns >= 5]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!due) return null;
  return (
    <div className="pointer-events-auto w-full rounded-2xl border border-line bg-panel/95 p-4 shadow-lg backdrop-blur">
      <FeedbackForm context="talk" onDone={() => setTimeout(() => setDue(false), 1200)} />
    </div>
  );
}
