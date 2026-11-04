import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Avatar } from '../avatar/Avatar.tsx';
import { Behaviour } from '../avatar/behaviour.ts';
import type { Rig } from '../avatar/LivingAvatar.tsx';
import { Button } from '../components/ui.tsx';

// i-persons.com/@<handle> (Phase 6b): talk to someone's twin. No account needed.

const LivingAvatar = lazy(() => import('../avatar/LivingAvatar.tsx').then((m) => ({ default: m.LivingAvatar })));

interface Profile { handle: string; name: string; display_name: string; bio: string | null; greeting: string; neutral_avatar: boolean; rig: Rig; scene: { url: string; credit?: string; credit_url?: string } | null; allow: Record<string, boolean>; facts: string[] }
interface Line { role: 'visitor' | 'twin'; text: string }

async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(`/api/public${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.token ? { 'X-Visitor-Token': init.token } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data as { message?: string }).message ?? 'error'), { status: res.status });
  return data as T;
}

export function PublicTwin() {
  const { slug = '' } = useParams();
  const handle = slug.replace(/^@/, '');
  const [p, setP] = useState<Profile | null | 'missing'>(null);
  const [session, setSession] = useState<{ id: string; token: string } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'chat' | 'message_only'>('chat');
  const [reporting, setReporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const behaviour = useMemo(() => new Behaviour(performance.now()), []);
  const started = useRef(Date.now());
  const size = Math.min(320, window.innerWidth - 48);

  useEffect(() => {
    if (!slug.startsWith('@')) { setP('missing'); return; }
    call<Profile>(`/${handle}`).then((r) => { setP(r); behaviour.dispatch({ type: 'open', firstVisitToday: true }, performance.now()); }).catch(() => setP('missing'));
  }, [slug, handle, behaviour]);

  // After asking the owner something, keep the chat in sync (their decision arrives as a twin message).
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => {
      // The greeting lives only here (it isn't stored), so compare against the rest.
      call<{ messages: Line[] }>(`/${handle}/conversations/${session.id}/messages`, { token: session.token })
        .then((r) => setLines((cur) => (r.messages.length > cur.length - 1 ? [cur[0]!, ...r.messages] : cur))).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [session, handle]);

  if (p === null) return <p className="p-6 text-muted">Loading…</p>;
  if (p === 'missing') return <div className="grid min-h-full place-items-center p-6 text-center text-muted">This i-person doesn’t exist or isn’t public.<br /><a className="mt-3 underline" href="/">i-persons.com</a></div>;

  const send = async (text: string) => {
    if (!session || !text.trim()) return;
    setBusy(true);
    setError(null);
    setLines((l) => [...l, { role: 'visitor', text }]);
    behaviour.dispatch({ type: 'thinking' }, performance.now());
    try {
      const r = await call<{ reply: string; mode: 'chat' | 'message_only' }>(`/${handle}/conversations/${session.id}/messages`, { body: { text }, token: session.token });
      setLines((l) => [...l, { role: 'twin', text: r.reply }]);
      setMode(r.mode);
      behaviour.dispatch({ type: 'speaking', mood: 'happy' }, performance.now());
      setTimeout(() => behaviour.dispatch({ type: 'speech_done' }, performance.now()), 2500);
    } catch (err) {
      setError((err as { status?: number }).status === 429 ? 'Slow down a little and try again in a minute.' : 'Something went wrong.');
      behaviour.dispatch({ type: 'error' }, performance.now());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rim-glow flex min-h-full flex-col items-center px-4 py-6">
      <div className="w-full max-w-xl space-y-4">
        <header className="flex items-center justify-between text-sm">
          <a href="/" className="font-semibold">i-persons</a>
          <button onClick={() => setReporting(true)} className="text-xs text-muted underline">Report this i-person</button>
        </header>
        <div className="flex flex-col items-center gap-2">
          <Suspense fallback={<Avatar imageUrl={p.rig.variants.base?.url ?? null} level={() => 0} state="idle" size={size} />}>
            <LivingAvatar rig={p.rig} level={() => 0} behaviour={() => behaviour.frame(performance.now())} state={busy ? 'thinking' : 'idle'} size={size} sceneUrl={p.scene?.url}
              onTap={() => behaviour.dispatch({ type: 'tap' }, performance.now())} />
          </Suspense>
          <h1 className="text-2xl font-semibold">{p.name}’s i-person</h1>
          <p className="text-center text-xs text-muted">An AI twin that represents {p.name}. It isn’t {p.name}, and it only knows what {p.name} made public.{p.neutral_avatar && ' Neutral avatar: this isn’t what they look like.'}</p>
          {p.bio && <p className="text-center text-sm text-white/80">{p.bio}</p>}
          {p.scene?.credit && <p className="text-[10px] text-muted">Scene photo: <a className="underline" href={p.scene.credit_url} target="_blank" rel="noreferrer">{p.scene.credit}</a></p>}
        </div>

        {!session ? (
          <form className="space-y-2 rounded-2xl border border-line bg-panel p-4 text-sm" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            try {
              const r = await call<{ conversation_id: string; token: string }>(`/${handle}/conversations`, { body: { name: f.get('name'), email: f.get('email') || undefined, phone: f.get('phone') || undefined, website: f.get('website') || undefined, ms: Date.now() - started.current } });
              setSession({ id: r.conversation_id, token: r.token });
              setLines([{ role: 'twin', text: p.greeting }]);
            } catch { setError('Couldn’t start the chat. Try again in a minute.'); }
          }}>
            <p>{p.greeting}</p>
            <p className="text-xs text-muted">So {p.name} knows who wrote:</p>
            <input name="name" required maxLength={60} placeholder="Your name" aria-label="Your name" className="w-full rounded-xl border border-line bg-ink px-3 py-2 outline-none" />
            <div className="flex gap-2">
              <input name="email" type="email" placeholder="Email (optional)" aria-label="Email" className="min-w-0 flex-1 rounded-xl border border-line bg-ink px-3 py-2 outline-none" />
              <input name="phone" placeholder="Phone (optional)" aria-label="Phone" className="w-36 rounded-xl border border-line bg-ink px-3 py-2 outline-none" />
            </div>
            {/* Honeypot for bots: hidden from people. */}
            <input name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 opacity-0" />
            <Button className="w-full">Start talking</Button>
          </form>
        ) : (
          <div className="space-y-3">
            <div className="max-h-[40vh] space-y-2 overflow-y-auto text-sm">
              {lines.map((l, i) => <p key={i} className={l.role === 'visitor' ? 'ml-10 rounded-2xl bg-white/10 px-3 py-2' : 'mr-10 whitespace-pre-line rounded-2xl border border-line px-3 py-2'}>{l.text}</p>)}
              {busy && <p className="mr-10 text-muted">…</p>}
            </div>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const i = e.currentTarget.elements.namedItem('t') as HTMLInputElement; void send(i.value); i.value = ''; }}>
              <input name="t" maxLength={1000} placeholder={mode === 'message_only' ? `Leave a message for ${p.name}…` : `Ask ${p.name}’s i-person…`} className="min-w-0 flex-1 rounded-full border border-line bg-panel px-4 py-2.5 outline-none" />
              <Button disabled={busy}>Send</Button>
            </form>
          </div>
        )}
        {error && <p className="text-center text-sm text-bad">{error}</p>}

        {reporting && (
          <form className="space-y-2 rounded-2xl border border-bad/40 p-4 text-sm" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            await call(`/${handle}/report`, { body: { reason: f.get('reason'), contact: f.get('contact') || undefined } }).catch(() => {});
            setReporting(false);
            setError('Thanks — we’ll review it.');
          }}>
            <textarea name="reason" required minLength={5} rows={3} placeholder="What’s wrong with this i-person?" className="w-full rounded-xl border border-line bg-ink px-3 py-2" />
            <input name="contact" placeholder="Your email (optional)" className="w-full rounded-xl border border-line bg-ink px-3 py-2" />
            <div className="flex gap-2"><Button variant="ghost" type="button" onClick={() => setReporting(false)}>Cancel</Button><Button variant="danger">Report</Button></div>
          </form>
        )}
        <p className="pt-4 text-center text-xs text-muted"><a href="/" className="underline">Create your own i-person</a></p>
      </div>
    </div>
  );
}
