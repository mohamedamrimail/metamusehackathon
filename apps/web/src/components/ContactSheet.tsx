import { RELATIONSHIP_GROUPS, TWIN_SCOPE_LABELS, TWIN_SCOPES, type ContactView, type TwinScope } from '@ipersons/shared';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';
import { ContactAvatar, RowAction, StatusBadge } from '../pages/Contacts.tsx';
import { InviteSheet } from './InviteSheet.tsx';
import { PlanDetail, PlanWizard } from './Plans.tsx';
import { Button } from './ui.tsx';

// The contact sheet (§2): details, editable relationship and note, actions, plans together, permissions.

export interface PlanSummary { id: string; title: string; status: string; when: string | null; place: string | null; role: 'creator' | 'participant'; waiting_for_me: boolean }
export interface SheetData {
  contact: ContactView;
  plans: PlanSummary[];
  permissions?: { mine: string[]; theirs: string[]; my_fact_ids: string[]; facts: { id: string; label: string }[] };
}

export function Sheet({ onClose, children, label }: { onClose(): void; children: ReactNode; label: string }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 md:items-stretch md:justify-end" onClick={onClose}>
      <div role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()}
        className="sheet-in max-h-[88vh] w-full overflow-y-auto overflow-x-hidden rounded-t-3xl border border-line bg-ink p-5 md:max-h-none md:w-[26rem] md:rounded-none md:rounded-l-3xl">
        {children}
      </div>
    </div>
  );
}

export type SheetMode = 'main' | 'invite' | 'plan' | 'detail';

export function ContactSheet({ id, initialMode, onClose, onChange }: { id: string; initialMode?: SheetMode; onClose(): void; onChange(): void }) {
  const [data, setData] = useState<SheetData | null>(null);
  const [mode, setMode] = useState<SheetMode>(initialMode ?? 'main');
  const [planId, setPlanId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => setData(await api<SheetData>(`/contacts/${id}`)), [id]);
  // Not on onClose: the parent passes a new function on every render.
  useEffect(() => void load().catch(() => onClose()), [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => { void load(); onChange(); };
  const c = data?.contact;

  return (
    <Sheet onClose={onClose} label={c?.name ?? 'Contact'}>
      {!c ? <p className="text-muted">Loading…</p> : mode === 'main' ? (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <ContactAvatar c={c} size={56} />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-semibold">{c.name}</h2>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted"><StatusBadge c={c} />{c.twin && <span>{c.twin.name}</span>}</div>
            </div>
            <button aria-label="Close" className="self-start text-muted hover:text-white" onClick={onClose}>✕</button>
          </div>
          {notice && <p className="rounded-xl border border-ok/40 p-3 text-sm">{notice}</p>}
          <Details c={c} onSaved={changed} />
          <div className="flex flex-wrap gap-2">
            {c.status === 'not_yet' || c.status === 'invited'
              ? <Button onClick={() => setMode('invite')}>{c.status === 'invited' ? 'Remind' : 'Invite'}</Button>
              : c.status === 'connected' ? <Button onClick={() => setMode('plan')}>Plan something</Button>
                : <RowAction c={c} onChange={changed} onOpen={() => {}} />}
          </div>
          {data.plans.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs uppercase tracking-wider text-muted">Plans together</h3>
              <ul className="space-y-2 text-sm">
                {data.plans.map((p) => (
                  <li key={p.id} className={`cursor-pointer rounded-xl border p-3 ${p.waiting_for_me ? 'border-warn/50' : 'border-line'}`} onClick={() => { setPlanId(p.id); setMode('detail'); }}>
                    <p className="font-medium">{p.title}</p>
                    <p className="text-xs text-muted">{p.status.replace(/_/g, ' ')}{p.when ? ` · ${p.when}` : ''}{p.place ? ` · ${p.place}` : ''}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.permissions && c.connection_id && <Permissions connectionId={c.connection_id} name={c.name} p={data.permissions} onChange={changed} />}
          {c.connection_id && <SafetyActions connectionId={c.connection_id} c={c} onChange={changed} />}
          <div className="border-t border-line pt-4">
            <button className="text-sm text-bad" onClick={async () => {
              if (!confirm(`Remove ${c.name} from your contacts? Your twin forgets them.`)) return;
              await api(`/contacts/${c.id}`, { method: 'DELETE' });
              onChange();
              onClose();
            }}>Remove contact</button>
          </div>
        </div>
      ) : (
        <div>
          <button className="mb-3 text-sm text-muted" onClick={() => setMode('main')}>← {c.name}</button>
          {mode === 'invite' && <InviteSheet c={c} onDone={() => { setMode('main'); changed(); }} />}
          {mode === 'plan' && <PlanWizard c={c} onDone={(m) => { setNotice(m); setMode('main'); changed(); }} />}
          {mode === 'detail' && planId && <PlanDetail id={planId} onChange={changed} />}
        </div>
      )}
    </Sheet>
  );
}

function Details({ c, onSaved }: { c: ContactView; onSaved(): void }) {
  const [relationship, setRelationship] = useState(c.relationship ?? 'other');
  const [notes, setNotes] = useState(c.notes ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = relationship !== (c.relationship ?? 'other') || notes !== (c.notes ?? '');
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-wider text-muted">Relationship</span>
        <select value={relationship} onChange={(e) => setRelationship(e.target.value)} className="w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm">
          {RELATIONSHIP_GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-wider text-muted">Note <span className="normal-case opacity-60">{notes.length}/100</span></span>
        <input value={notes} maxLength={100} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. likes padel, met at Yousoft"
          className="w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-rim/60" />
      </label>
      {dirty && (
        <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={async () => {
          try {
            await api(`/contacts/${c.id}`, { method: 'PATCH', body: { relationship, notes: notes.trim() || null } });
            setMsg('Saved');
            onSaved();
          } catch (err) { setMsg(err instanceof ApiError ? err.message : 'Could not save'); }
        }}>Save</Button>
      )}
      {msg && <p className="text-xs text-muted">{msg}</p>}
      {(c.status === 'not_yet' || c.status === 'invited') && <AddAddress c={c} onSaved={onSaved} />}
    </div>
  );
}

/** Not found on i-persons? Their WhatsApp number or another email may be the one they verified. */
function AddAddress({ c, onSaved }: { c: ContactView; onSaved(): void }) {
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const add = async () => {
    const v = value.trim();
    if (!v) return;
    try {
      const r = await api<{ contact: ContactView }>(`/contacts/${c.id}`, { method: 'PATCH', body: v.includes('@') ? { add_email: v } : { add_phone: v } });
      setValue('');
      setMsg(r.contact.status === 'not_yet' || r.contact.status === 'invited' ? 'Added. Not on i-persons with this one either.' : `Added: ${c.name} is on i-persons.`);
      onSaved();
    } catch (err) { setMsg(err instanceof ApiError ? err.message : 'Could not add it'); }
  };
  return (
    <div className="space-y-1.5 border-t border-line pt-3">
      <span className="block text-xs uppercase tracking-wider text-muted">Add a phone number or email</span>
      <div className="flex gap-2">
        <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} placeholder="+216 24 000 000 or name@mail.com"
          className="min-w-0 flex-1 rounded-xl border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-rim/60" />
        <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={() => void add()}>Add</Button>
      </div>
      <p className="text-xs text-muted">We find people on i-persons by the WhatsApp number or Google/Microsoft email they verified.</p>
      {msg && <p className="text-xs text-muted">{msg}</p>}
    </div>
  );
}

/** §4 What I let my twin share with this person's twin (my side only), and what they let theirs share. */
function Permissions({ connectionId, name, p, onChange }: { connectionId: string; name: string; p: NonNullable<SheetData['permissions']>; onChange(): void }) {
  const [mine, setMine] = useState<string[]>(p.mine);
  const [facts, setFacts] = useState<string[]>(p.my_fact_ids);
  const save = async (patch: { scopes?: string[]; fact_ids?: string[] }) => {
    const r = await api<{ mine: string[]; my_fact_ids: string[] }>(`/twin-connections/${connectionId}`, { method: 'PATCH', body: patch });
    setMine(r.mine);
    setFacts(r.my_fact_ids);
  };
  return (
    <div>
      <h3 className="mb-2 text-xs uppercase tracking-wider text-muted">What my twin may share with {name}’s</h3>
      <div className="space-y-2">
        {TWIN_SCOPES.map((s: TwinScope) => (
          <label key={s} className="flex items-start gap-3 rounded-xl border border-line p-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-white" checked={mine.includes(s)}
              onChange={(e) => void save({ scopes: e.target.checked ? [...mine, s] : mine.filter((x) => x !== s) })} />
            <span className="min-w-0"><span className="block font-medium">{TWIN_SCOPE_LABELS[s].title}</span><span className="text-xs text-muted">{TWIN_SCOPE_LABELS[s].detail}</span></span>
          </label>
        ))}
      </div>
      {mine.includes('preferences') && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-muted">Preferences I share (nothing else):</p>
          {!p.facts.length ? <p className="text-xs text-muted/70">Your twin hasn’t learned any preferences yet.</p> : p.facts.map((f) => (
            <label key={f.id} className="flex items-start gap-2 py-1 text-sm">
              <input type="checkbox" className="mt-0.5 shrink-0 accent-white" checked={facts.includes(f.id)}
                onChange={(e) => void save({ fact_ids: e.target.checked ? [...facts, f.id] : facts.filter((x) => x !== f.id) })} />
              <span className="min-w-0 break-words">{f.label}</span>
            </label>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-muted">{name} lets their twin share: {p.theirs.map((s) => TWIN_SCOPE_LABELS[s as TwinScope]?.title ?? s).join(', ') || 'nothing yet'}.</p>
      <Button variant="ghost" className="mt-3 px-4 py-1.5 text-xs" onClick={async () => {
        if (!confirm(`Disconnect your twin from ${name}’s? Open plans are cancelled.`)) return;
        await api(`/twin-connections/${connectionId}/disconnect`, { method: 'POST' });
        onChange();
      }}>Disconnect</Button>
    </div>
  );
}

/** Block and report, on every connection. */
function SafetyActions({ connectionId, c, onChange }: { connectionId: string; c: ContactView; onChange(): void }) {
  if (c.status === 'blocked') {
    return <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={async () => { await api(`/twin-connections/${connectionId}/unblock`, { method: 'POST' }); onChange(); }}>Unblock</Button>;
  }
  return (
    <div className="flex flex-wrap gap-3 text-xs">
      <button className="text-muted underline" onClick={async () => {
        if (!confirm(`Block ${c.name}’s i-person? Their twin can’t contact yours, and they won’t see you on i-persons.`)) return;
        await api(`/twin-connections/${connectionId}/block`, { method: 'POST' }).catch((err) => alert(err instanceof ApiError ? err.message : 'Failed'));
        onChange();
      }}>Block</button>
      <button className="text-muted underline" onClick={async () => {
        const reason = prompt('What happened? (sent to the i-persons team; the i-person is also blocked)');
        if (!reason || reason.trim().length < 3) return;
        await api(`/twin-connections/${connectionId}/report`, { body: { reason } }).catch((err) => alert(err instanceof ApiError ? err.message : 'Failed'));
        onChange();
      }}>Report</button>
    </div>
  );
}
