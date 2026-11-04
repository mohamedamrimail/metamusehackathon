import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useFeatures } from '../features.ts';
import { useSession } from '../session.tsx';

// DEMO: the "Meta AI calls" panel, docked on the right over the whole height like a browser's inspector (demo accounts
// only; Admin → Settings → showCallsPanel turns it off for everyone, the » hides it in this browser). Each live call
// arrives over GET /api/demo/calls (server-sent events), newest on top: the Meta model, what it did, its latency; plus
// the app's own steps (approval gate, rules, twin-to-twin, calendar, WhatsApp, email). The page narrows by --calls-w.

interface Call { id: number; at: string; service: string; meta: boolean; what: string; ms?: number; simulated?: string; ok: boolean; twin?: string }

const KEY = 'ip_calls_panel';
const WIDTH = '380px';
const COLORS: Record<string, string> = {
  'Muse Spark': 'bg-[#0866ff] text-white',
  'Muse Voice Transcribe': 'bg-[#7c3aed] text-white',
  'Muse Image': 'bg-[#db2777] text-white',
  'SAM 3.1': 'bg-[#059669] text-white',
};
const readHidden = () => { try { return localStorage.getItem(KEY) === 'off'; } catch { return false; } };

export function CallsPanel() {
  const { user } = useSession();
  const f = useFeatures();
  const [calls, setCalls] = useState<Call[]>([]);
  const [hidden, setHidden] = useState(readHidden);
  const [metaOnly, setMetaOnly] = useState(false);
  const newest = useRef(0);
  const on = user?.account_kind === 'demo' && f?.calls_panel === true;
  // Wide screens get the docked panel and a narrower page; on phones it would cover everything, so it stays a button.
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const fn = () => setWide(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  const docked = on && !hidden && wide;

  useEffect(() => {
    document.documentElement.style.setProperty('--calls-w', docked ? WIDTH : '0px');
    return () => document.documentElement.style.setProperty('--calls-w', '0px');
  }, [docked]);

  useEffect(() => {
    if (!on) return;
    const es = new EventSource('/api/demo/calls');
    es.onmessage = (m) => {
      const c = JSON.parse(m.data) as Call;
      newest.current = Math.max(newest.current, c.id);
      setCalls((x) => (x.some((y) => y.id === c.id) ? x : [c, ...x].sort((a, b) => b.id - a.id).slice(0, 150)));
    };
    return () => es.close();
  }, [on]);

  if (!on) return null;
  const toggle = (v: boolean) => { setHidden(v); try { localStorage.setItem(KEY, v ? 'off' : 'on'); } catch { /* fine */ } };
  const clear = () => { setCalls([]); void api('/demo/calls/clear', { method: 'POST' }).catch(() => {}); };
  const models = calls.filter((c) => c.meta).length;

  if (!docked) {
    return (
      <button onClick={() => { toggle(false); if (!wide) setWide(true); }} className="fixed bottom-4 right-4 z-40 rounded-full border border-line bg-ink/90 px-3 py-1.5 text-xs text-muted backdrop-blur hover:text-white">
        « Meta AI calls ({models})
      </button>
    );
  }
  const shown = metaOnly ? calls.filter((c) => c.meta) : calls;
  return (
    <aside aria-label="Meta AI calls" style={{ width: WIDTH }} className="fixed inset-y-0 right-0 z-50 flex flex-col border-l border-line bg-[#07090d] text-xs shadow-2xl">
      <header className="space-y-2 border-b border-line px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#22c55e]" />
          <strong className="text-sm text-white">Meta AI calls</strong>
          <span className="text-muted">live · {models} model call{models === 1 ? '' : 's'}</span>
          <button onClick={() => toggle(true)} aria-label="Hide the panel" title="Hide" className="ml-auto px-1 text-base leading-none text-muted hover:text-white">»</button>
        </div>
        <div className="flex items-center gap-3 text-muted">
          <label className="flex items-center gap-1"><input type="checkbox" checked={metaOnly} onChange={(e) => setMetaOnly(e.target.checked)} />Meta models only</label>
          <button onClick={clear} className="ml-auto rounded-full border border-line px-2.5 py-0.5 hover:border-white/40 hover:text-white">Clear</button>
        </div>
      </header>
      <ol className="flex-1 space-y-1.5 overflow-y-auto p-2">
        {!shown.length && <li className="p-2 text-muted">Talk to your twin: each Meta model call appears here, newest on top.</li>}
        {shown.map((c) => (
          <li key={c.id} className={`rounded-lg border px-2 py-1.5 ${c.id === newest.current ? 'border-white/40 bg-white/[0.03]' : 'border-line'} ${c.ok ? '' : 'border-red-500/60'}`}>
            <div className="flex items-center gap-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${COLORS[c.service] ?? 'bg-white/10 text-white/80'}`}>{c.service}</span>
              {c.twin && <span className="text-muted">{c.twin}</span>}
              {c.simulated && <span className="rounded bg-warn/15 px-1 text-[10px] text-warn" title={c.simulated}>simulated</span>}
              <span className="ml-auto tabular-nums text-muted">{c.ms != null ? `${c.ms.toLocaleString()} ms` : new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            </div>
            <p className="mt-0.5 leading-snug text-white/85">{c.what}</p>
          </li>
        ))}
      </ol>
    </aside>
  );
}
