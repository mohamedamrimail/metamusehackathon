import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Button } from './ui.tsx';

// Connect a mailbox (addendum 2, M1/M2): pick Outlook or Gmail and a 1–3 month window, see the cost
// before the first read, then watch progress.

interface Box { id: string; provider: 'microsoft' | 'google'; email: string; window_months: number; last_sync_at: string | null; status: string; progress: { done: number; total: number; sources: string[] } | null; error: string | null;
  life_scan: boolean; import_contacts: boolean; import_calendar: boolean; counts: { people?: number; contacts?: number; events?: number }; grants: { contacts: boolean; calendar: boolean } }
interface State { providers: { microsoft: boolean; google: boolean }; verified: boolean; mailboxes: Box[]; demo: { allowed: boolean; mailboxes: string[] } | null }
const NAME = { microsoft: 'Outlook', google: 'Gmail' } as const;

export function ConnectMailbox({ services }: { services: string }) {
  const [s, setS] = useState<State | null>(null);
  const [months, setMonths] = useState(1);
  useEffect(() => { api<State>('/connections/mail').then(setS).catch(() => {}); }, []);
  if (!s) return null;
  if (!s.verified) return <p className="text-sm text-muted">Link your WhatsApp number on My twin first: only verified users can connect a mailbox.</p>;
  const available = (['microsoft', 'google'] as const).filter((p) => s.providers[p]);
  if (!available.length) return <p className="text-sm text-muted">Mailbox: not configured on this server (needs MS_CLIENT_ID/SECRET or GOOGLE_CLIENT_ID/SECRET).</p>;
  if (s.demo && !s.demo.allowed) return <DemoNote />;
  return (
    <div className="space-y-3 text-sm">
      {s.demo && <DemoNote mailboxes={s.demo.mailboxes} />}
      <p className="text-muted">Your twin reads <strong className="text-white">only emails from {services}</strong>, from the last:</p>
      <div className="flex gap-2">
        {[1, 2, 3].map((m) => <button key={m} type="button" onClick={() => setMonths(m)} className={`flex-1 rounded-full border px-3 py-1.5 ${months === m ? 'border-white bg-white text-black' : 'border-line'}`}>{m} month{m > 1 ? 's' : ''}</button>)}
      </div>
      <div className="flex gap-2">
        {available.map((p) => <a key={p} href={`/api/connections/${p}/start?window=${months}`} className="flex-1 rounded-full bg-white py-2.5 text-center font-medium text-black">Connect {NAME[p]}</a>)}
      </div>
      <p className="text-xs text-muted">Read-only access. Raw emails are never kept: only orders and bookings. Disconnect any time.</p>
    </div>
  );
}

export function Mailboxes() {
  const [s, setS] = useState<State | null>(null);
  const [est, setEst] = useState<Record<string, { emails: number; cost_usd: number; sources: string[] } | string>>({});
  const load = useCallback(() => api<State>('/connections/mail').then(setS).catch(() => {}), []);
  useEffect(() => void load(), [load]);
  const syncing = s?.mailboxes.some((b) => b.status === 'syncing');
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [syncing, load]);
  useEffect(() => {
    for (const b of s?.mailboxes ?? []) {
      if (b.last_sync_at || est[b.id]) continue;
      setEst((e) => ({ ...e, [b.id]: 'Counting emails…' }));
      api<{ emails: number; cost_usd: number; sources: string[] }>(`/connections/mail/${b.id}/estimate`)
        .then((r) => setEst((e) => ({ ...e, [b.id]: r }))).catch((err) => setEst((e) => ({ ...e, [b.id]: err instanceof ApiError ? err.message : 'Couldn’t reach your mailbox.' })));
    }
  }, [s, est]);
  if (!s?.mailboxes.length) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-xs uppercase tracking-wider text-muted">Connected mailboxes</h2>
      {s.mailboxes.map((b) => {
        const e = est[b.id];
        return (
          <div key={b.id} className="space-y-2 rounded-2xl border border-line bg-panel p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span><strong>{NAME[b.provider]}</strong> <span className="text-muted">{b.email} · last {b.window_months} month{b.window_months > 1 ? 's' : ''}</span></span>
              {b.status === 'needs_reconnect' ? <a href={`/api/connections/${b.provider}/start?window=${b.window_months}`} className="flex items-center gap-1.5 text-xs text-warn"><span className="h-2 w-2 rounded-full bg-warn" />Reconnect</a>
                : <span className="text-xs text-muted">{b.last_sync_at ? `Updated ${new Date(b.last_sync_at).toLocaleString()}` : 'Not read yet'}</span>}
            </div>
            {b.status === 'syncing' && b.progress && (
              <div>
                <p className="text-xs text-muted">{b.progress.total ? `Reading ${b.progress.done} of ${b.progress.total} emails from ${b.progress.sources.join(' and ')}…` : 'Learning who you know and syncing your calendar…'}</p>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full bg-rim" style={{ width: `${b.progress.total ? (b.progress.done / b.progress.total) * 100 : 0}%` }} /></div>
              </div>
            )}
            {!b.last_sync_at && b.status !== 'syncing' && (typeof e === 'string' ? <p className="text-xs text-muted">{e}</p> : e && (
              e.emails ? <Button className="w-full" onClick={async () => { await api(`/connections/mail/${b.id}/sync`, { method: 'POST' }); void load(); }}>
                Read {e.emails} email{e.emails > 1 ? 's' : ''} from {e.sources.join(' and ')}: about ${e.cost_usd.toFixed(2)}
              </Button> : <p className="text-xs text-muted">No emails from {e.sources.join(' and ') || 'your active services'} in this window yet.</p>
            ))}
            <LifeScan box={b} onChange={load} />
            <div className="flex gap-3 text-xs">
              <select aria-label="Window" value={b.window_months} className="rounded-full border border-line bg-ink px-2 py-1" onChange={async (ev) => {
                const m = Number(ev.target.value);
                if (m < b.window_months && !confirm(`Shrinking to ${m} month(s) deletes what your twin learned from older emails. Continue?`)) return;
                await api(`/connections/mail/${b.id}`, { method: 'PATCH', body: { window_months: m } });
                void load();
              }}>{[1, 2, 3].map((m) => <option key={m} value={m}>Last {m} month{m > 1 ? 's' : ''}</option>)}</select>
              <button className="text-bad" onClick={async () => {
                const purge = confirm('Also delete everything learned from this mailbox (orders, bookings, insights)? OK = delete it all, Cancel = keep it.');
                await api(`/connections/mail/${b.id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
                void load();
              }}>Disconnect</button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * Three separate opt-ins, all off by default (jury §4): people from personal mail, the address book and
 * the calendar. Contacts and calendar ask Microsoft / Google for their permission only when switched on.
 */
function LifeScan({ box: b, onChange }: { box: Box; onChange(): void }) {
  const [explain, setExplain] = useState(false);
  const c = b.counts;
  const set = async (field: 'life_scan' | 'import_contacts' | 'import_calendar', on: boolean, what: string) => {
    const forget = !on && confirm(`Also delete ${what}? OK = delete it, Cancel = keep it.`);
    const r = await api<{ ok?: boolean; needs_consent?: string }>(`/connections/mail/${b.id}`, { method: 'PATCH', body: { [field]: on, forget } });
    if (r.needs_consent) { location.href = r.needs_consent; return; }
    onChange();
  };
  const Row = ({ on, label, note, onToggle }: { on: boolean; label: string; note: string; onToggle(on: boolean): void }) => (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="checkbox" className="mt-0.5" checked={on} onChange={(ev) => onToggle(ev.target.checked)} />
      <span><strong>{label}</strong><span className="block text-xs text-muted">{note}</span></span>
    </label>
  );
  return (
    <div className="space-y-2 rounded-xl border border-line/70 p-2.5">
      <Row on={b.life_scan} label="Learn who I know" note={`Your family, friends and colleagues, from who you email with.${c.people ? ` Knows ${c.people} people.` : ''}`}
        onToggle={(on) => (on ? setExplain(true) : void set('life_scan', false, 'the people learned from your emails'))} />
      <Row on={b.import_contacts} label="Import my contacts" note={`Names, emails, phone numbers and birthdays from your address book.${c.contacts ? ` ${c.contacts} imported.` : ''}${!b.grants.contacts ? ` ${NAME[b.provider]} will ask your permission.` : ''}`}
        onToggle={(on) => void set('import_contacts', on, 'the imported contacts')} />
      <Row on={b.import_calendar} label="Import my calendar" note={`Your events from 30 days back to 90 days ahead, read-only.${c.events ? ` ${c.events} events.` : ''}${!b.grants.calendar ? ` ${NAME[b.provider]} will ask your permission.` : ''}`}
        onToggle={(on) => void set('import_calendar', on, 'the imported calendar events')} />
      {explain && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={() => setExplain(false)}>
          <div className="w-full max-w-md space-y-3 rounded-2xl border border-line bg-panel p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <p className="text-base font-medium">Learn who I know</p>
            <div><p className="font-medium">What your twin reads</p><p className="text-muted">From your emails in the chosen window: the names and addresses of senders and recipients, the subjects, and the short preview {NAME[b.provider]} shows. Never whole emails.</p></div>
            <div><p className="font-medium">What it keeps</p><p className="text-muted">Per person: the name, the email address, the relationship and role it worked out (e.g. “friend”, “accountant”), a one-line note in its own words, and when it learned it.</p></div>
            <div><p className="font-medium">What it never keeps</p><p className="text-muted">Subjects, previews and email text. They are used only while reading, then dropped.</p></div>
            <p className="text-muted">Private to you: never shown to visitors or partners, and only used when you ask about your people. You can forget anyone on My twin, or switch this off and delete it all.</p>
            <div className="flex gap-2 pt-1">
              <button className="flex-1 rounded-full border border-line py-2" onClick={() => setExplain(false)}>Not now</button>
              <button className="flex-1 rounded-full bg-white py-2 font-medium text-black" onClick={async () => { setExplain(false); await set('life_scan', true, ''); }}>Turn on</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 5a.3: paste one confirmation email instead of connecting a mailbox (handy for demos). */
export function PasteConfirmation({ slug, name }: { slug: string; name: string }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted">Or paste a {name} confirmation</summary>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder={`Paste the whole ${name} confirmation email here…`}
        className="mt-2 w-full rounded-xl border border-line bg-ink px-3 py-2 outline-none" />
      <Button variant="ghost" className="mt-1 w-full" disabled={busy || text.trim().length < 40} onClick={async () => {
        setBusy(true);
        setNote(null);
        try {
          const r = await api<{ learned: number; insights: number }>(`/store/${slug}/paste`, { body: { text } });
          setNote(r.learned ? `Learned ${r.learned} item${r.learned > 1 ? 's' : ''}. See My twin → Insights.` : 'Nothing to learn in that email (it should be an order or booking confirmation).');
          setText('');
        } catch (err) {
          setNote(err instanceof ApiError ? err.message : 'Couldn’t read it.');
        } finally {
          setBusy(false);
        }
      }}>{busy ? 'Reading…' : 'Learn from it'}</Button>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </details>
  );
}

const MAILBOX_MESSAGES: Record<string, string> = {
  connected: 'Mailbox connected. Check the estimate below, then start reading.',
  verify_first: 'Link your WhatsApp number on My twin first.',
  scope_too_broad: 'That connection asked for more than read-only access, so we didn’t keep it. Please try again.',
  cancelled: 'Connection cancelled.',
  expired: 'That took too long. Please try again.',
  no_offline_access: 'We need offline access to keep learning. Please try again and allow it.',
  unavailable: 'Mailbox connections are coming soon.',
  failed: 'Couldn’t connect your mailbox. Please try again.',
  demo_only: 'Email learning is a closed demo during the hackathon. It opens to everyone soon.',
  demo_mailbox: 'During the demo only the demo mailboxes can be connected, so we didn’t keep that one.',
  contacts_on: 'Contacts allowed. Your twin is importing your address book now.',
  calendar_on: 'Calendar allowed. Your twin is importing your events now.',
};

export function MailboxBanner() {
  const code = new URLSearchParams(location.search).get('mailbox');
  if (!code || !MAILBOX_MESSAGES[code]) return null;
  return <p role="status" className={`rounded-2xl border p-3 text-sm ${code === 'connected' ? 'border-ok/40 bg-ok/10' : 'border-warn/40 bg-warn/10'}`}>{MAILBOX_MESSAGES[code]}</p>;
}

/** Hackathon: mailbox learning runs on the demo accounts only. */
export function DemoNote({ mailboxes }: { mailboxes?: string[] }) {
  return (
    <p className="rounded-xl border border-rim/30 bg-rim/10 p-3 text-sm">
      <span className="mr-2 rounded-full border border-rim/40 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-rim">Demo</span>
      {mailboxes?.length ? `Demo mailboxes: ${mailboxes.join(', ')}.` : 'Email learning is a closed demo during the hackathon. Connecting your own mailbox opens soon.'}
    </p>
  );
}
