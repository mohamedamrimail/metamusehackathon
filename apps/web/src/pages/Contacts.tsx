import { RELATIONSHIP_GROUPS, type ContactStatus, type ContactView } from '@ipersons/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { Button } from '../components/ui.tsx';
import { ContactSheet, Sheet, type SheetMode } from '../components/ContactSheet.tsx';
import { PlanDetail, PlansWaiting } from '../components/Plans.tsx';

// Contacts (docs/twin-to-twin.md §2): who of my contacts has an i-person; invite, connect twins, plan.

type Filter = 'all' | 'on' | 'connected' | 'invited' | 'not_yet';
const FILTERS: [Filter, string][] = [['all', 'All'], ['on', 'On i-persons'], ['connected', 'Connected'], ['invited', 'Invited'], ['not_yet', 'Not yet']];
const inFilter = (c: ContactView, f: Filter) =>
  f === 'all' ? true
    : f === 'on' ? ['on_iperson', 'requested', 'incoming', 'connected'].includes(c.status)
      : f === 'connected' ? c.status === 'connected'
        : f === 'invited' ? c.status === 'invited'
          : c.status === 'not_yet';
const groupOf = (r: string | null) => (r === 'business' ? 'client' : RELATIONSHIP_GROUPS.some((g) => g.id === r) ? r! : 'other');
const REL_ORDER = Object.fromEntries(RELATIONSHIP_GROUPS.map((g, i) => [g.id, i]));

export function Contacts() {
  const [list, setList] = useState<ContactView[] | null>(null);
  const [synced, setSynced] = useState(true);
  const [requests, setRequests] = useState<Request[]>([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<'name' | 'relationship'>('name');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<{ id: string; mode?: SheetMode } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await api<{ contacts: ContactView[]; synced: boolean; requests: Request[] }>('/contacts');
      setList(r.contacts);
      setRequests(r.requests ?? []);
      setReloadKey((k) => k + 1);
      setSynced(r.synced);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your contacts.');
      setList([]);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = (list ?? []).filter((c) => inFilter(c, filter) && (!needle || `${c.name} ${c.label ?? ''} ${c.twin?.name ?? ''}`.toLowerCase().includes(needle)));
    return rows.sort((a, b) => (sort === 'relationship' ? (REL_ORDER[groupOf(a.relationship)]! - REL_ORDER[groupOf(b.relationship)]!) : 0) || a.name.localeCompare(b.name));
  }, [list, q, filter, sort]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([f]) => [f, (list ?? []).filter((c) => inFilter(c, f)).length])), [list]);

  if (list && !synced) return <EmptyState onAdded={load} />;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">Contacts</h1>
        <p className="text-sm text-muted">See who has an i-person. Connect your twins so they can plan coffee, dinners and meetings with you. Nothing is booked without both of your yes.</p>
        <FindSomeone onAdded={load} />
      </div>
      <div style={{ top: 'calc(3.6rem + var(--beta-h, 0px))' }} className="sticky z-10 -mx-4 space-y-2 border-b border-line bg-ink/90 px-4 pb-3 pt-1 backdrop-blur">
        <div className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search contacts"
            className="min-w-0 flex-1 rounded-full border border-line bg-panel px-4 py-2 text-sm outline-none focus:border-rim/60" />
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort" className="shrink-0 rounded-full border border-line bg-panel px-3 py-2 text-sm">
            <option value="name">Name</option>
            <option value="relationship">Relationship</option>
          </select>
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {FILTERS.map(([f, label]) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs ${filter === f ? 'border-white bg-white text-black' : 'border-line text-muted hover:text-white'}`}>
              {label} <span className="opacity-60">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      {requests.map((r) => <RequestCard key={r.connection_id} r={r} onChange={load} />)}
      <PlansWaiting onOpen={setPlanOpen} reloadKey={reloadKey} />
      {list === null ? <p className="mt-6 text-muted">Loading…</p> : !shown.length ? <p className="mt-6 text-sm text-muted">Nobody here{q ? ` matching “${q}”` : ''}.</p> : (
        <div className="mt-3 space-y-3">
          {RELATIONSHIP_GROUPS.map((g) => {
            const rows = shown.filter((c) => groupOf(c.relationship) === g.id);
            if (!rows.length) return null;
            return (
              <section key={g.id} className="rounded-2xl border border-line bg-panel">
                <button className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => setClosed({ ...closed, [g.id]: !closed[g.id] })} aria-expanded={!closed[g.id]}>
                  <span className="text-xs font-medium uppercase tracking-wider text-muted">{g.label} <span className="opacity-60">{rows.length}</span></span>
                  <span className="text-muted">{closed[g.id] ? '▸' : '▾'}</span>
                </button>
                {!closed[g.id] && (
                  <ul>
                    {rows.map((c) => <Row key={c.id} c={c} onOpen={(mode) => setOpen({ id: c.id, mode })} onChange={load} />)}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
      {planOpen && <Sheet label="Plan" onClose={() => setPlanOpen(null)}><PlanDetail id={planOpen} onChange={load} /></Sheet>}
      {open && <ContactSheet id={open.id} initialMode={open.mode} onClose={() => setOpen(null)} onChange={load} />}
    </div>
  );
}

interface Request { connection_id: string; name: string; twin_name: string | null }

/** A connection request from someone who isn't in my contacts (e.g. the person whose invite I used). */
function RequestCard({ r, onChange }: { r: Request; onChange(): void }) {
  const act = (verb: string) => async () => { await api(`/twin-connections/${r.connection_id}/${verb}`, { method: 'POST', body: {} }).catch(() => {}); onChange(); };
  return (
    <div className="mt-3 rounded-2xl border border-warn/40 bg-panel p-4 text-sm">
      <p><strong>{r.name}</strong> wants to connect {r.twin_name ? <>their i-person <span className="text-muted">({r.twin_name})</span></> : 'their i-person'} with yours, so your twins can plan meetings together. You approve every plan.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button className="px-4 py-1.5 text-xs" onClick={act('accept')}>Accept</Button>
        <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={act('decline')}>Decline</Button>
        <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={act('block')}>Block</Button>
      </div>
    </div>
  );
}

function EmptyState({ onAdded }: { onAdded(): void }) {
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12 text-center">
      <h1 className="text-2xl font-semibold">Contacts</h1>
      <div className="text-left"><FindSomeone onAdded={onAdded} open /></div>
      <p className="mt-8 text-sm text-muted">Or let your twin learn who you know:</p>
      <p className="mt-3 text-muted">Your twin doesn’t know your contacts yet. Connect your mailbox in the Store and turn on “Learn who I know”: you’ll see who already has an i-person, invite the others, and let your twins plan together.</p>
      <Link to="/store" className="mt-6 inline-block rounded-full bg-white px-5 py-2.5 text-sm font-medium text-black">Connect contacts</Link>
      <p className="mt-4 text-xs text-muted">Your contacts stay private: never shown to visitors, partners or anyone else.</p>
    </div>
  );
}

export function ContactAvatar({ c, size = 40 }: { c: ContactView; size?: number }) {
  const ring = c.status === 'on_iperson' || c.status === 'incoming' || c.status === 'requested' ? 'ring-2 ring-rim' : c.status === 'connected' ? 'ring-2 ring-ok' : '';
  return (
    <span className={`relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-line text-sm font-semibold ${ring}`} style={{ width: size, height: size }}>
      {c.twin?.avatar ? <img src={c.twin.avatar} alt="" className="h-full w-full object-cover" loading="lazy" /> : c.initials}
      {c.status === 'connected' && <span aria-hidden className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full bg-ok text-[10px] text-black">✓</span>}
    </span>
  );
}

const BADGE: Record<ContactStatus, [string, string]> = {
  on_iperson: ['On i-persons', 'text-rim border-rim/40'],
  connected: ['Connected', 'text-ok border-ok/40'],
  requested: ['Request sent', 'text-warn border-warn/40'],
  incoming: ['Wants to connect', 'text-warn border-warn/40'],
  invited: ['Invited', 'text-muted border-line'],
  not_yet: ['Not yet', 'text-muted/70 border-line/60'],
  blocked: ['Blocked', 'text-bad border-bad/40'],
};

export function StatusBadge({ c }: { c: ContactView }) {
  const [label, tone] = BADGE[c.status];
  const when = c.invited ? ` ${new Date(c.invited.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '';
  return <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tone}`}>{label}{when}</span>;
}

/** The row's main button, by status. */
export function RowAction({ c, onChange, onOpen }: { c: ContactView; onChange(): void; onOpen(mode?: SheetMode): void }) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try { await fn(); } catch (err) { alert(err instanceof ApiError ? err.message : 'Something went wrong.'); }
    setBusy(false);
    onChange();
  };
  const small = 'px-3 py-1.5 text-xs';
  switch (c.status) {
    case 'on_iperson': return <Button className={small} disabled={busy} onClick={run(() => api(`/contacts/${c.id}/connect`, { method: 'POST' }))}>Connect twins</Button>;
    case 'connected': return <Button className={small} onClick={() => onOpen('plan')}>Plan something</Button>;
    case 'requested': return <Button variant="ghost" className={small} disabled={busy} onClick={run(() => api(`/twin-connections/${c.connection_id}/cancel`, { method: 'POST' }))}>Cancel</Button>;
    case 'incoming': return (
      <span className="flex shrink-0 gap-1.5">
        <Button variant="ghost" className={small} disabled={busy} onClick={run(() => api(`/twin-connections/${c.connection_id}/decline`, { method: 'POST' }))}>Decline</Button>
        <Button className={small} disabled={busy} onClick={run(() => api(`/twin-connections/${c.connection_id}/accept`, { method: 'POST', body: {} }))}>Accept</Button>
      </span>
    );
    case 'invited': return c.invited?.can_remind ? <Button variant="ghost" className={small} onClick={() => onOpen('invite')}>Remind</Button> : null;
    case 'not_yet': return <Button variant="ghost" className={small} onClick={() => onOpen('invite')}>Invite</Button>;
    default: return null;
  }
}

function Row({ c, onOpen, onChange }: { c: ContactView; onOpen(mode?: SheetMode): void; onChange(): void }) {
  return (
    <li className="flex items-center gap-3 border-t border-line/60 px-4 py-3">
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onOpen()}>
        <ContactAvatar c={c} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{c.name}</span>
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
            <StatusBadge c={c} />
            <span className="truncate">{c.twin ? c.twin.name : c.label ?? c.relationship ?? ''}</span>
          </span>
        </span>
      </button>
      <RowAction c={c} onChange={onChange} onOpen={onOpen} />
    </li>
  );
}

interface Found { name: string; twin_name: string; handle: string | null; via: 'number' | 'email' | 'public'; in_contacts: boolean }

/**
 * Find someone on i-persons without syncing: by the WhatsApp number or email they verified (if they let contacts find
 * them), or a public twin by name or @handle. Not a directory of everyone.
 */
function FindSomeone({ onAdded, open: startOpen = false }: { onAdded(): void; open?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ results: Found[]; query?: { phone?: string; email?: string } } | null>(null);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const v = q.trim();
    if (v.length < 3) { setRes(null); return; }
    const t = setTimeout(() => { api<NonNullable<typeof res>>(`/contacts/search?q=${encodeURIComponent(v)}`).then(setRes).catch((e) => setMsg(e instanceof ApiError ? e.message : 'Search failed')); }, 350);
    return () => clearTimeout(t);
  }, [q]);
  const add = async (body: object, label: string) => {
    setMsg(null);
    try {
      const r = await api<{ contact: ContactView }>('/contacts', { body });
      setMsg(r.contact.status === 'not_yet' ? `${label} added to your contacts. Not on i-persons yet: you can invite them.` : `${label} added to your contacts.`);
      setQ(''); setName(''); setRes(null);
      onAdded();
    } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Could not add'); }
  };
  if (!open) return <button className="mt-2 text-sm text-rim underline" onClick={() => setOpen(true)}>Find someone on i-persons</button>;
  const query = res?.query;
  return (
    <div className="mt-3 space-y-2 rounded-2xl border border-line bg-panel/60 p-3">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="WhatsApp number, email, name or @handle"
        className="w-full rounded-full border border-line bg-ink px-4 py-2 text-sm outline-none focus:border-rim/60" />
      {res?.results.map((f) => (
        <div key={`${f.name}-${f.handle}`} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2 text-sm">
          <span className="min-w-0"><span className="font-medium">{f.name}</span> <span className="text-muted">· {f.twin_name}{f.handle ? ` · @${f.handle}` : ''}</span></span>
          {f.in_contacts ? <span className="shrink-0 text-xs text-muted">In your contacts</span>
            : <Button variant="ghost" className="shrink-0 px-4 py-1.5 text-xs" onClick={() => void add(f.via === 'public' && f.handle ? { handle: f.handle } : { ...query }, f.name)}>Add</Button>}
        </div>
      ))}
      {res && !res.results.length && query && (
        <div className="space-y-2 text-sm">
          <p className="text-muted">Not found on i-persons with this {query.email ? 'email' : 'number'}. Add them anyway, and invite them:</p>
          <div className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name" className="min-w-0 flex-1 rounded-full border border-line bg-ink px-3 py-1.5 text-sm outline-none" />
            <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={() => void add({ ...query, name: name.trim() || undefined }, name.trim() || 'Contact')}>Add contact</Button>
          </div>
        </div>
      )}
      {res && !res.results.length && !query && <p className="text-sm text-muted">No public i-person with that name. Try their WhatsApp number or email.</p>}
      <p className="text-xs text-muted">People are found only by a number or email they verified (if they allow it), or by their public twin.</p>
      {msg && <p className="text-xs text-rim">{msg}</p>}
    </div>
  );
}
