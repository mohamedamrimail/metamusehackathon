import { useCallback, useEffect, useRef, useState } from 'react';

// Meta Ray-Ban Display web app (i-persons.com/glasses?k=<device token>): the twin floats in view (black is see-through on
// the additive display), says its latest line, and waiting cards get Approve / Decline with the Neural Band. No mic or
// camera on glasses web apps: requests are typed or dictated in the system composer. Pairing: My twin → Glasses.

const KEY = 'ip_glasses';
const POLL_MS = 3000;

interface Card { id: string; summary: string; risk: string; influenced_by: string | null; held_reason: string | null }
interface State { twin: { name: string; alive: boolean; poses: string[] }; lines: { role: 'user' | 'assistant'; text: string }[]; cards: Card[] }

function token(): string | null {
  try {
    const k = new URLSearchParams(location.search).get('k');
    if (k) {
      localStorage.setItem(KEY, k);
      history.replaceState(null, '', '/glasses'); // the token doesn't stay in the address
    }
    return localStorage.getItem(KEY);
  } catch {
    return new URLSearchParams(location.search).get('k');
  }
}

export function Glasses() {
  const [k] = useState(token);
  const [s, setS] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [img, setImg] = useState<Record<string, string>>({});
  const [pose, setPose] = useState('base');
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const lastSpoken = useRef<string | null>(null);

  const call = useCallback(async <T,>(path: string, body?: object): Promise<T> => {
    const res = await fetch(`/api/glasses${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${k}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message ?? data.error ?? 'Something went wrong');
    return data as T;
  }, [k]);

  const load = useCallback(async () => {
    try { setS(await call<State>('/state')); setError(null); } catch (e) { setError((e as Error).message); }
  }, [call]);
  useEffect(() => {
    if (!k) return;
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [k, load]);

  // The pose cut-outs, fetched with the device token (media needs it).
  const poses = s?.twin.poses.join(',');
  useEffect(() => {
    if (!k || !poses) return;
    for (const p of poses.split(',').filter((x) => ['base', 'blink', 'smile'].includes(x))) {
      void fetch(`/api/glasses/media/${p}`, { headers: { Authorization: `Bearer ${k}` } })
        .then((r) => (r.ok ? r.blob() : null)).then((b) => b && setImg((m) => ({ ...m, [p]: URL.createObjectURL(b) })));
    }
  }, [k, poses]);

  // Alive: a blink every few seconds.
  useEffect(() => {
    if (!img.blink) return;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => { t = setTimeout(() => { setPose('blink'); setTimeout(() => setPose('base'), 160); loop(); }, 2800 + Math.random() * 2500); };
    loop();
    return () => clearTimeout(t);
  }, [img.blink]);

  // A new reply: smile for a moment and say it (speech is a bonus; the text stays on screen).
  const latest = [...(s?.lines ?? [])].reverse().find((l) => l.role === 'assistant')?.text ?? null;
  useEffect(() => {
    if (!latest) return;
    if (lastSpoken.current === null) { lastSpoken.current = latest; return; } // not on first load
    if (latest === lastSpoken.current) return;
    lastSpoken.current = latest;
    if (img.smile) { setPose('smile'); setTimeout(() => setPose('base'), 2500); }
    try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(latest)); } catch { /* no speech here */ }
  }, [latest, img.smile]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try { await call('/say', { text: t }); setText(''); setAsking(false); await load(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const decide = async (id: string, ok: boolean) => {
    setBusy(true);
    try { await call(`/actions/${id}/${ok ? 'confirm' : 'reject'}`, {}); await load(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const shell = 'mx-auto flex h-screen max-h-[600px] w-full max-w-[600px] flex-col items-center overflow-hidden bg-black px-6 py-4 text-white';
  if (!k) {
    return (
      <div className={`${shell} justify-center text-center`}>
        <p className="text-2xl font-semibold">i-persons</p>
        <p className="mt-3 text-lg text-white/80">Pair these glasses on your phone: My twin → Glasses → scan the code.</p>
      </div>
    );
  }
  const card = s?.cards[0];
  return (
    <div className={shell} style={{ background: '#000' }}>
      <div className="flex w-full items-center justify-between text-base text-white/60">
        <span>{s?.twin.name ?? 'i-persons'}</span>
        {s && s.cards.length > 0 && <span className="text-[#9ec5ff]">{s.cards.length} waiting</span>}
      </div>
      {card ? (
        <div className="mt-3 flex w-full flex-1 flex-col justify-center gap-4">
          <p className="text-sm uppercase tracking-wider text-[#9ec5ff]">Needs your yes</p>
          <p className="text-2xl leading-snug">{card.summary}</p>
          {card.influenced_by && <p className="text-base text-[#fbbf24]">⚠ Suggested after reading {card.influenced_by}</p>}
          <div className="flex gap-3">
            <button disabled={busy} onClick={() => void decide(card.id, false)} className="flex-1 rounded-full border-2 border-white/60 py-3 text-xl focus:border-white focus:bg-white/20">Decline</button>
            <button disabled={busy} onClick={() => void decide(card.id, true)} className="flex-1 rounded-full bg-white py-3 text-xl font-semibold text-black focus:ring-4 focus:ring-[#9ec5ff]">Approve</button>
          </div>
        </div>
      ) : (
        <>
          <div className="relative mt-1 flex min-h-0 flex-1 items-end justify-center">
            {img.base ? <img src={img[pose] ?? img.base} alt="" className="max-h-full max-w-full object-contain" /> : <div className="h-40 w-40 rounded-full border border-white/20" />}
          </div>
          <p className="mt-2 line-clamp-3 w-full text-center text-xl leading-snug" aria-live="polite">{latest ?? `Hi, I’m ${s?.twin.name ?? 'your twin'}.`}</p>
          {asking ? (
            <div className="mt-3 flex w-full gap-2">
              <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} placeholder="Ask your twin…"
                className="min-w-0 flex-1 rounded-full border-2 border-white/40 bg-black px-4 py-2 text-lg text-white outline-none focus:border-white" />
              <button disabled={busy} onClick={() => void send()} className="rounded-full bg-white px-5 text-lg font-semibold text-black">{busy ? '…' : 'Send'}</button>
            </div>
          ) : (
            <button onClick={() => setAsking(true)} className="mt-3 rounded-full border-2 border-white/60 px-8 py-2 text-xl focus:border-white focus:bg-white/20">Ask</button>
          )}
        </>
      )}
      {error && <p className="mt-2 text-base text-[#f87171]">{error}</p>}
    </div>
  );
}
