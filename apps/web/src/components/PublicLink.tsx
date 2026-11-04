import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { useSession } from '../session.tsx';
import { Button, Panel } from './ui.tsx';

// My twin → Public link (Phase 6a): i-persons.com/@handle, off by default.

interface Settings { handle: string | null; enabled: boolean; greeting: string | null; bio: string | null; allow: { answer: boolean; messages: boolean; meetings: boolean }; open_to_jobs: boolean; visitor_budget_usd: number; url: string | null }

export function PublicLinkPanel() {
  const { user, iperson } = useSession();
  const id = iperson!.id;
  const [s, setS] = useState<Settings | null>(null);
  const [handle, setHandle] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => api<Settings>(`/ipersons/${id}/public`).then((r) => { setS(r); setHandle(r.handle ?? ''); }), [id]);
  useEffect(() => void load(), [load]);
  if (!s) return null;
  const save = async (body: object) => {
    setNote(null);
    try {
      await api(`/ipersons/${id}/public`, { method: 'PATCH', body });
      await load();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Couldn’t save.');
    }
  };
  const toggle = 'flex items-center gap-2 text-sm';
  return (
    <Panel title="Public link" aside={s.enabled ? <span className="text-xs text-ok">Live</span> : <span className="text-xs text-muted">Off</span>}>
      <div className="space-y-3 text-sm">
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save({ handle }); }}>
          <span className="text-muted">i-persons.com/@</span>
          <input value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase())} maxLength={30} aria-label="Handle"
            className="min-w-0 flex-1 rounded-full border border-line bg-ink px-3 py-1.5 outline-none" />
          <Button variant="ghost" className="px-3 py-1.5" disabled={!handle || handle === s.handle}>Save</Button>
        </form>
        <label className={toggle}>
          <input type="checkbox" className="accent-white" checked={s.enabled} disabled={!user?.verified && !s.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
          Anyone with the link can talk to my twin{!user?.verified && <span className="text-xs text-warn"> (verify WhatsApp first)</span>}
        </label>
        {s.url && s.enabled && (
          <div className="flex items-center gap-2 rounded-xl border border-line p-2">
            <a href={`/@${s.handle}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate underline">{s.url.replace(/^https?:\/\//, '')}</a>
            <button className="text-xs" onClick={() => void navigator.clipboard?.writeText(s.url!).then(() => setNote('Link copied.'))}>Copy</button>
          </div>
        )}
        <textarea defaultValue={s.bio ?? ''} onBlur={(e) => e.target.value !== (s.bio ?? '') && void save({ bio: e.target.value || null })} rows={2} maxLength={500} placeholder="Short public bio"
          className="w-full rounded-xl border border-line bg-ink px-3 py-2 outline-none" />
        <input defaultValue={s.greeting ?? ''} onBlur={(e) => e.target.value !== (s.greeting ?? '') && void save({ greeting: e.target.value || null })} maxLength={300} placeholder="Greeting for visitors"
          className="w-full rounded-xl border border-line bg-ink px-3 py-2 outline-none" />
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs uppercase tracking-wider text-muted">My twin may</legend>
          {([['answer', 'Answer questions about me (public facts only)'], ['messages', 'Take messages for me'], ['meetings', 'Ask me to approve meetings']] as const).map(([k, label]) => (
            <label key={k} className={toggle}><input type="checkbox" className="accent-white" checked={s.allow[k]} onChange={(e) => void save({ allow: { ...s.allow, [k]: e.target.checked } })} />{label}</label>
          ))}
          <label className={toggle}><input type="checkbox" className="accent-white" checked={s.open_to_jobs} onChange={(e) => void save({ open_to_jobs: e.target.checked })} />Open to job offers (recruiters in the Store)</label>
        </fieldset>
        <label className={toggle}>
          Daily budget for visitors $
          <input type="number" min={0} max={20} step={0.1} defaultValue={s.visitor_budget_usd} onBlur={(e) => void save({ visitor_budget_usd: Number(e.target.value) })}
            className="w-20 rounded-full border border-line bg-ink px-2 py-1" />
        </label>
        <p className="text-xs text-muted">Only facts you mark <span className="text-rim">Public</span> are shared. Visitors spend your AI credit up to this budget; after that they can only leave a message.</p>
        {note && <p className="text-xs">{note}</p>}
      </div>
    </Panel>
  );
}
