import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Button, Panel } from '../components/ui.tsx';

// P8: Yousoft's recruiter portal — a thin client of the Partner API (through /org/yousoft/*).

interface Job { id: string; title: string; status: string; created_at: string; matches: number }
interface Match { twin_id: string; score: number; reason: string; stage: string; conversation_id: string | null; detail: { shared?: { slot?: string; name?: string; email?: string } } | null }
const STAGE: Record<string, string> = { matched: 'Matched', chatting: 'Chatting', interview_requested: 'Interview requested', interview_confirmed: 'Interview confirmed', contact_requested: 'Contact requested', contact_shared: 'Contact shared', declined: 'Declined', expired: 'No answer' };
const base = '/org/yousoft';

export function OrgPortal() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => api<{ jobs: Job[] }>(`${base}/jobs`).then((r) => setJobs(r.jobs)).catch((e) => setError(e instanceof ApiError && e.code === 'not_a_member' ? 'This portal is for Yousoft IT team members.' : 'Couldn’t load the portal.')), []);
  useEffect(() => void load(), [load]);
  if (error) return <p className="p-6 text-muted">{error}</p>;
  if (!jobs) return <p className="p-6 text-muted">Loading…</p>;
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5 px-4 py-6 lg:grid-cols-[1fr_1.4fr] [&>*]:min-w-0">
      <div className="space-y-5">
        <Panel title="Yousoft IT · Recruiting" aside={<span className="text-xs text-muted">via the Partner API</span>}>
          <form className="space-y-2 text-sm" onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            await api(`${base}/jobs`, { body: { title: f.get('title'), description: f.get('description'), requirements: { skills: String(f.get('skills')).split(',').map((s) => s.trim()).filter(Boolean) }, location: f.get('location') || undefined, remote: f.get('remote') === 'on', countries: String(f.get('countries')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) } });
            e.currentTarget.reset();
            setTimeout(() => void load(), 4000); // matching runs in the background
            void load();
          }}>
            <input name="title" required minLength={3} placeholder="Job title" className="w-full rounded-xl border border-line bg-ink px-3 py-2" />
            <textarea name="description" required minLength={10} rows={3} placeholder="Description" className="w-full rounded-xl border border-line bg-ink px-3 py-2" />
            <input name="skills" placeholder="Skills, comma-separated (React, TypeScript)" className="w-full rounded-xl border border-line bg-ink px-3 py-2" />
            <div className="flex gap-2">
              <input name="location" placeholder="Location" className="min-w-0 flex-1 rounded-xl border border-line bg-ink px-3 py-2" />
              <input name="countries" placeholder="Countries" className="w-32 rounded-xl border border-line bg-ink px-3 py-2" />
            </div>
            <label className="flex items-center gap-2 text-muted"><input type="checkbox" name="remote" className="accent-white" />Remote possible</label>
            <Button className="w-full">Post job</Button>
          </form>
        </Panel>
        <Panel title="Jobs">
          <ul className="divide-y divide-line text-sm">
            {jobs.map((j) => (
              <li key={j.id}>
                <button onClick={() => setOpen(j.id)} className={`flex w-full items-center justify-between py-2.5 text-left ${open === j.id ? 'text-white' : 'text-white/80'}`}>
                  <span>{j.title}{j.status !== 'open' && <span className="text-xs text-muted"> · closed</span>}</span>
                  <span className="text-xs text-muted">{j.matches} match{j.matches === 1 ? '' : 'es'}</span>
                </button>
              </li>
            ))}
            {!jobs.length && <li className="py-2 text-muted">No jobs yet.</li>}
          </ul>
        </Panel>
      </div>
      {open ? <Matches jobId={open} title={jobs.find((j) => j.id === open)?.title ?? ''} /> : <Panel title="Matches"><p className="text-sm text-muted">Pick a job to see matched twins.</p></Panel>}
    </div>
  );
}

function Matches({ jobId, title }: { jobId: string; title: string }) {
  const [list, setList] = useState<Match[]>([]);
  const [chat, setChat] = useState<{ twin: string; conv: string | null; lines: { who: string; text: string }[] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => api<{ matches: Match[] }>(`${base}/jobs/${jobId}/matches`).then((r) => setList(r.matches)), [jobId]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [load]);

  const request = async (twin: string, kind: 'schedule' | 'share_cv' | 'share_contact') => {
    setNote(null);
    let slots: string[] | undefined;
    if (kind === 'schedule') {
      const day = new Date(Date.now() + 2 * 86_400_000);
      slots = [10, 14, 16].map((h) => { const d = new Date(day); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); });
    }
    try {
      await api(`${base}/requests`, { body: { offer_id: jobId, twin_id: twin, kind, slots } });
      setNote(kind === 'schedule' ? 'Interview requested (3 slots in two days). The person approves or declines.' : 'Request sent. The person approves or declines.');
      void load();
    } catch (err) { setNote(err instanceof ApiError ? err.message : 'Failed'); }
  };

  return (
    <Panel title={`Matches · ${title}`}>
      {note && <p className="mb-3 rounded-xl border border-rim/40 bg-rim/10 p-2 text-sm">{note}</p>}
      <ul className="space-y-2 text-sm">
        {list.map((m) => (
          <li key={m.twin_id} className="rounded-xl border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <code className="text-xs text-muted">{m.twin_id.slice(0, 12)}…</code>
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{STAGE[m.stage] ?? m.stage}</span>
              <span className="text-lg font-semibold tabular-nums">{m.score}</span>
            </div>
            <p className="mt-1 text-white/80">{m.reason}</p>
            {m.detail?.shared && <p className="mt-1 text-xs text-ok">{m.detail.shared.slot ? `Interview: ${new Date(m.detail.shared.slot).toLocaleString()}` : ''} {m.detail.shared.name ?? ''} {m.detail.shared.email ?? ''}</p>}
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              <button className="underline" onClick={() => setChat({ twin: m.twin_id, conv: m.conversation_id, lines: [] })}>Chat with twin</button>
              <button className="underline" onClick={() => void request(m.twin_id, 'schedule')}>Request interview</button>
              <button className="underline" onClick={() => void request(m.twin_id, 'share_cv')}>Ask for CV</button>
              <button className="underline" onClick={() => void request(m.twin_id, 'share_contact')}>Ask for contact</button>
            </div>
          </li>
        ))}
        {!list.length && <li className="text-muted">No matches yet. Matching runs right after posting and every night.</li>}
      </ul>
      {chat && (
        <div className="mt-4 space-y-2 rounded-xl border border-line p-3 text-sm">
          <div className="flex justify-between"><span className="text-xs uppercase tracking-wider text-muted">Chat with {chat.twin.slice(0, 12)}…</span><button className="text-xs text-muted" onClick={() => setChat(null)}>Close</button></div>
          {chat.lines.map((l, i) => <p key={i} className={l.who === 'you' ? 'text-right text-white/70' : ''}>{l.text}</p>)}
          <form className="flex gap-2" onSubmit={async (e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem('q') as HTMLInputElement;
            const text = input.value.trim();
            if (!text) return;
            input.value = '';
            setChat((c) => c && { ...c, lines: [...c.lines, { who: 'you', text }] });
            try {
              const r = await api<{ reply: string; conversation_id: string }>(`${base}/chat`, { body: { offer_id: jobId, twin_id: chat.twin, conversation_id: chat.conv ?? undefined, text } });
              setChat((c) => c && { ...c, conv: r.conversation_id, lines: [...c.lines, { who: 'twin', text: r.reply }] });
            } catch (err) {
              setChat((c) => c && { ...c, lines: [...c.lines, { who: 'twin', text: err instanceof ApiError ? `(${err.message})` : '(failed)' }] });
            }
          }}>
            <input name="q" placeholder="Ask the twin about this job…" className="min-w-0 flex-1 rounded-full border border-line bg-ink px-3 py-2" />
            <Button variant="ghost">Send</Button>
          </form>
        </div>
      )}
    </Panel>
  );
}
