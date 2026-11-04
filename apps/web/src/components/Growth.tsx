import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.ts';

// Growth §2: the "twin chain" challenge (Talk + My twin), the badge, and the pilot session page (/s/<code>).

interface Chain { started: boolean; steps: { connect: boolean; plan: boolean; booked: boolean }; completed: boolean; credit_usd: number }

export function ChainCard({ compact = false, onClose }: { compact?: boolean; onClose?(): void }) {
  const [c, setC] = useState<Chain | null>(null);
  useEffect(() => { api<Chain>('/me/chain').then(setC).catch(() => {}); }, []);
  if (!c) return null;
  if (c.completed) {
    return compact ? null : <p className="text-sm">🏅 <strong>Twin chain done.</strong> You planned something with a friend through your i-persons.</p>;
  }
  const steps: [boolean, string][] = [
    [c.steps.connect, 'Invite or connect a friend'],
    [c.steps.plan, 'Plan a coffee through your twins'],
    [c.steps.booked, 'You both confirm'],
  ];
  return (
    <div className={compact ? 'pointer-events-auto w-full rounded-2xl border border-rim/40 bg-panel/95 p-4 text-sm shadow-lg backdrop-blur' : 'space-y-2 text-sm'}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">Plan a coffee with a friend through your i-persons</p>
        {onClose && <button aria-label="Close" className="text-muted" onClick={onClose}>✕</button>}
      </div>
      <ol className="mt-2 space-y-1">
        {steps.map(([done, label], i) => <li key={label} className={done ? 'text-ok' : 'text-white/80'}>{done ? '✓' : `${i + 1}.`} {label}</li>)}
      </ol>
      {c.credit_usd > 0 && <p className="mt-1 text-xs text-muted">When you’re both done, you each get ${c.credit_usd.toFixed(2)} of AI credit and a badge.</p>}
      <Link to="/contacts" onClick={() => { if (!c.started) void api('/me/chain/start', { method: 'POST' }); }}
        className="mt-3 inline-block rounded-full bg-white px-4 py-2 font-medium text-black">{c.started ? 'Continue' : 'Start'}</Link>
    </div>
  );
}

/** Talk: shown to people who haven't finished it, until closed for this browser. */
export function ChainPrompt() {
  const [open, setOpen] = useState(() => { try { return !localStorage.getItem('ip_chain_closed'); } catch { return true; } });
  if (!open) return null;
  return <ChainCard compact onClose={() => { setOpen(false); try { localStorage.setItem('ip_chain_closed', '1'); } catch { /* ignore */ } }} />;
}

interface Session { code: string; cohort: string; note: string | null; invite_url: string; open: boolean; signups: number; verified: number; twins: number }

/** /s/<code>: projected in a room. A big QR to join, and a live counter for this session's cohort. */
export function SessionPage() {
  const { code } = useParams();
  const [s, setS] = useState<Session | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const load = () => api<Session>(`/session/${code}`).then(setS).catch(() => setMissing(true));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [code]);
  useEffect(() => { if (s) void QRCode.toDataURL(s.invite_url, { margin: 1, width: 720, color: { dark: '#000000', light: '#ffffff' } }).then(setQr); }, [s?.invite_url]);
  if (missing) return <p className="p-8 text-center text-muted">This session code doesn’t exist.</p>;
  if (!s) return <p className="p-8 text-center text-muted">Loading…</p>;
  return (
    <div className="rim-glow flex min-h-full flex-col items-center justify-center gap-8 px-4 py-10 text-center">
      <h1 className="text-3xl font-semibold sm:text-5xl">Create your i-person</h1>
      {s.note && <p className="text-lg text-muted">{s.note}</p>}
      {qr && <img src={qr} alt="QR code to join" className="w-72 rounded-2xl sm:w-96" />}
      <p className="font-mono text-sm text-muted">{s.invite_url.replace(/^https?:\/\//, '')}</p>
      <div className="grid w-full max-w-2xl grid-cols-3 gap-4">
        {([['Signed up', s.signups], ['Verified', s.verified], ['Twins created', s.twins]] as const).map(([l, n]) => (
          <div key={l} className="rounded-2xl border border-line bg-panel p-4"><p className="text-4xl font-semibold tabular-nums sm:text-6xl">{n}</p><p className="mt-1 text-sm text-muted">{l}</p></div>
        ))}
      </div>
      {!s.open && <p className="text-warn">This session has ended.</p>}
    </div>
  );
}
