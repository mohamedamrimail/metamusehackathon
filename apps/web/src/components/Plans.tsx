import { PLAN_TYPE_LABELS, PLAN_TYPES, TIMES_OF_DAY, type ContactView, type PlanType, type TimeOfDay } from '@ipersons/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Button } from './ui.tsx';

// Twin-to-twin planning on the web (docs/twin-to-twin.md §5): the Plan wizard, and one plan's details
// (pick a time and a place, suggest another time once, decline; or, for the creator, trim the options).

const iso = (d: Date) => d.toISOString().slice(0, 10);
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d; };
const DURATIONS = [30, 45, 60, 90, 120, 180];

export function PlanWizard({ c, onDone }: { c: ContactView; onDone(msg: string): void }) {
  const mon = nextMonday();
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  const [type, setType] = useState<PlanType>('coffee');
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(60);
  const [from, setFrom] = useState(iso(mon));
  const [to, setTo] = useState(iso(fri));
  const [tod, setTod] = useState<TimeOfDay>('any');
  const [area, setArea] = useState('');
  const [budget, setBudget] = useState('');
  const [note, setNote] = useState('');
  const [auto, setAuto] = useState(false);
  const [card, setCard] = useState<{ action_id: string; summary: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = 'w-full min-w-0 rounded-xl border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-rim/60';

  if (card) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Send it?</h2>
        <p className="rounded-xl border border-rim/40 bg-rim/5 p-3 text-sm">{card.summary}</p>
        <p className="text-xs text-muted">Your twins then find times that suit you both. Nothing is booked until you both say yes.</p>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={busy} onClick={async () => { await api(`/actions/${card.action_id}/reject`, { method: 'POST' }).catch(() => {}); setCard(null); }}>Back</Button>
          <Button disabled={busy} className="flex-1" onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ action: { status: string; result?: { error?: string } } }>(`/actions/${card.action_id}/confirm`, { method: 'POST' });
              onDone(r.action.status === 'done' ? `Sent to ${c.name}'s i-person.` : r.action.result?.error ?? 'It could not be sent.');
            } catch (err) { setMsg(err instanceof ApiError ? err.message : 'Failed'); }
            setBusy(false);
          }}>Approve</Button>
        </div>
        {msg && <p className="text-sm text-bad">{msg}</p>}
      </div>
    );
  }

  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setMsg(null);
      try {
        setCard(await api<{ action_id: string; summary: string }>('/plans', { body: {
          contacts: [c.id], type, ...(type === 'custom' && title ? { title } : {}), duration_minutes: duration, date_from: from, date_to: to,
          time_of_day: tod, ...(area ? { area } : {}), ...(budget ? { budget } : {}), ...(note ? { note } : {}), auto_confirm: auto,
        } }));
      } catch (err) { setMsg(err instanceof ApiError ? err.message : 'Something went wrong.'); }
      setBusy(false);
    }}>
      <h2 className="text-lg font-semibold">Plan something with {c.name}</h2>
      <div className="flex flex-wrap gap-1.5">
        {PLAN_TYPES.map((t) => (
          <button type="button" key={t} onClick={() => setType(t)}
            className={`rounded-full border px-3 py-1 text-xs ${type === t ? 'border-white bg-white text-black' : 'border-line text-muted'}`}>{PLAN_TYPE_LABELS[t]}</button>
        ))}
      </div>
      {type === 'custom' && <input className={input} placeholder="What? e.g. Board games" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />}
      <div className="grid grid-cols-2 gap-2">
        <label className="min-w-0 text-xs text-muted">From<input type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="min-w-0 text-xs text-muted">To<input type="date" className={input} value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="min-w-0 text-xs text-muted">How long
          <select className={input} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>{DURATIONS.map((d) => <option key={d} value={d}>{d < 60 ? `${d} min` : `${d / 60} h`}</option>)}</select>
        </label>
        <label className="min-w-0 text-xs text-muted">Time of day
          <select className={input} value={tod} onChange={(e) => setTod(e.target.value as TimeOfDay)}>{TIMES_OF_DAY.map((t) => <option key={t} value={t}>{t === 'any' ? 'Any time' : t[0]!.toUpperCase() + t.slice(1)}</option>)}</select>
        </label>
      </div>
      <input className={input} placeholder="Where? near me, between us, a district or city" value={area} maxLength={100} onChange={(e) => setArea(e.target.value)} />
      <input className={input} placeholder="Budget (optional)" value={budget} maxLength={60} onChange={(e) => setBudget(e.target.value)} />
      <input className={input} placeholder={`A note for ${c.name} (optional)`} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-white" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Accept any of the options I send</label>
      <Button className="w-full" disabled={busy}>Next</Button>
      {msg && <p className="text-sm text-bad">{msg}</p>}
    </form>
  );
}

interface PlanViewData {
  id: string; title: string; status: string; role: 'creator' | 'participant'; from: string | null; others?: number;
  with?: { name: string; status: string }[]; note: string | null; note_from_other: boolean; can_answer: boolean; can_counter: boolean; can_edit_options: boolean;
  slots: { id: string; label: string; removed: boolean; source: string }[];
  places: { id: string; name: string; address?: string; url?: string; reservation_url?: string; partner?: string; removed: boolean }[];
  booked: { when: string; place: string | null } | null; duration_minutes: number; date_from: string; date_to: string;
}

export function PlanDetail({ id, onChange }: { id: string; onChange(): void }) {
  const [d, setD] = useState<{ plan: PlanViewData; card: { id: string; kind: string; summary: string } | null } | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [place, setPlace] = useState<string | undefined>();
  const [counter, setCounter] = useState<{ from: string; to: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await api<NonNullable<typeof d>>(`/plans/${id}`);
    setD(r);
    setSlots((s) => (s.length ? s : r.plan.slots.filter((x) => !x.removed).slice(0, 1).map((x) => x.id)));
    setPlace((p) => p ?? r.plan.places.find((x) => !x.removed)?.id);
  }, [id]);
  useEffect(() => void load().catch(() => setMsg('Could not load this plan.')), [load]);
  if (!d) return <p className="text-sm text-muted">{msg ?? 'Loading…'}</p>;
  const p = d.plan;
  const group = (p.others ?? 0) > 0;
  const act = async (fn: () => Promise<unknown>) => {
    setMsg(null);
    try { await fn(); await load(); onChange(); } catch (err) { setMsg(err instanceof ApiError ? err.message : 'Something went wrong.'); }
  };
  const live = p.slots.filter((s) => !s.removed || p.can_edit_options);

  return (
    <div className="space-y-4 text-sm">
      <div>
        <h2 className="text-lg font-semibold">{p.title}{p.from ? ` with ${p.from}` : p.with ? ` with ${p.with.map((w) => w.name).join(', ')}` : ''}</h2>
        <p className="text-xs capitalize text-muted">{p.status.replace(/_/g, ' ')}{group ? ` · with ${p.others} other${p.others! > 1 ? 's' : ''}` : ''}</p>
      </div>
      {p.booked && <p className="rounded-xl border border-ok/40 p-3">Set: {p.booked.when}{p.booked.place ? ` at ${p.booked.place}` : ''}</p>}
      {p.note && (
        <p className="rounded-xl border border-line p-3 text-muted">
          {p.note_from_other ? <>Note from {p.from} <span className="text-xs">(their words, not checked)</span>: </> : 'Your note: '}
          <span className="whitespace-pre-wrap break-words text-white">“{p.note}”</span>
        </p>
      )}
      {p.with && <p className="text-xs text-muted">{p.with.map((w) => `${w.name}: ${w.status.replace(/_/g, ' ')}`).join(' · ')}</p>}
      {live.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs uppercase tracking-wider text-muted">{p.can_answer ? (group ? 'Which times work for you?' : 'Pick a time') : 'Times'}</h3>
          {live.map((s) => (
            <label key={s.id} className={`flex items-center gap-2 py-1 ${s.removed ? 'opacity-40 line-through' : ''}`}>
              {p.can_answer && <input type={group ? 'checkbox' : 'radio'} name="slot" className="accent-white" checked={slots.includes(s.id)}
                onChange={(e) => setSlots(group ? (e.target.checked ? [...slots, s.id] : slots.filter((x) => x !== s.id)) : [s.id])} />}
              {p.can_edit_options && <input type="checkbox" className="accent-white" checked={!s.removed} aria-label="Keep this time"
                onChange={(e) => void act(() => api(`/plans/${p.id}/options/${s.id}`, { method: 'PATCH', body: { removed: !e.target.checked } }))} />}
              <span>{s.label}{s.source === 'counter' ? ' (suggested)' : ''}</span>
            </label>
          ))}
        </div>
      )}
      {p.places.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs uppercase tracking-wider text-muted">{p.can_answer ? 'Pick a place' : 'Places'}</h3>
          {p.places.filter((x) => !x.removed || p.can_edit_options).map((x) => (
            <label key={x.id} className={`flex items-start gap-2 py-1 ${x.removed ? 'opacity-40 line-through' : ''}`}>
              {p.can_answer && <input type="radio" name="place" className="mt-1 accent-white" checked={place === x.id} onChange={() => setPlace(x.id)} />}
              {p.can_edit_options && <input type="checkbox" className="mt-1 accent-white" checked={!x.removed} aria-label="Keep this place"
                onChange={(e) => void act(() => api(`/plans/${p.id}/options/${x.id}`, { method: 'PATCH', body: { removed: !e.target.checked } }))} />}
              <span className="min-w-0 break-words">
                {x.name}{x.partner && <span className="ml-1 rounded-full border border-rim/40 px-1.5 text-[10px] uppercase text-rim">Partner</span>}
                {x.address && <span className="block text-xs text-muted">{x.address}</span>}
                {x.url && <a href={x.url} target="_blank" rel="noreferrer noopener" className="text-xs text-rim underline">Page</a>}
                {x.reservation_url && <> · <a href={x.reservation_url} target="_blank" rel="noreferrer noopener" className="text-xs text-rim underline">Reserve</a></>}
              </span>
            </label>
          ))}
        </div>
      )}
      {p.can_answer && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => void act(() => api(`/plans/${p.id}/answer`, { body: { decline: true } }))}>Decline</Button>
            <Button className="flex-1" disabled={!slots.length} onClick={() => void act(() => api(`/plans/${p.id}/answer`, { body: { slot_option_ids: slots, ...(place ? { place_option_id: place } : {}) } }))}>Accept</Button>
          </div>
          {p.can_counter && !counter && <button className="text-xs text-muted underline" onClick={() => setCounter({ from: p.date_from, to: p.date_to })}>Suggest another time</button>}
          {counter && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-muted">From<input type="date" value={counter.from} onChange={(e) => setCounter({ ...counter, from: e.target.value })} className="block rounded-xl border border-line bg-panel px-2 py-1.5 text-sm" /></label>
              <label className="text-xs text-muted">To<input type="date" value={counter.to} min={counter.from} onChange={(e) => setCounter({ ...counter, to: e.target.value })} className="block rounded-xl border border-line bg-panel px-2 py-1.5 text-sm" /></label>
              <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => void act(() => api(`/plans/${p.id}/answer`, { body: { counter: { date_from: counter.from, date_to: counter.to } } }))}>Suggest my free times</Button>
            </div>
          )}
          <button className="text-xs text-muted underline" onClick={() => {
            const reason = prompt('What happened? (sent to the i-persons team; their i-person is also blocked)');
            if (reason && reason.trim().length >= 3) void act(() => api(`/plans/${p.id}/report`, { body: { reason } }));
          }}>Block and report</button>
        </div>
      )}
      {d.card && !p.can_answer && (
        <div className="rounded-xl border border-rim/40 bg-rim/5 p-3">
          <p>{d.card.summary}</p>
          <div className="mt-2 flex gap-2">
            <Button variant="ghost" className="px-4 py-1.5 text-xs" onClick={() => void act(() => api(`/actions/${d.card!.id}/reject`, { method: 'POST' }))}>Decline</Button>
            <Button className="px-4 py-1.5 text-xs" onClick={() => void act(() => api(`/actions/${d.card!.id}/confirm`, { method: 'POST' }))}>Approve</Button>
          </div>
        </div>
      )}
      {p.role === 'creator' && ['sent', 'negotiating', 'awaiting_confirmation'].includes(p.status) && (
        <button className="text-xs text-bad" onClick={() => void act(() => api(`/plans/${p.id}/cancel`, { method: 'POST' }))}>Call it off</button>
      )}
      {msg && <p className="text-bad">{msg}</p>}
    </div>
  );
}

/** Plans waiting for me, on top of the Contacts page. */
export function PlansWaiting({ onOpen, reloadKey }: { onOpen(id: string): void; reloadKey: number }) {
  const [plans, setPlans] = useState<(PlanViewData & { can_answer: boolean })[]>([]);
  useEffect(() => { api<{ plans: PlanViewData[] }>('/plans').then((r) => setPlans(r.plans)).catch(() => {}); }, [reloadKey]);
  const open = plans.filter((p) => ['sent', 'negotiating', 'awaiting_confirmation'].includes(p.status) || (p.status === 'booked' && p.booked));
  if (!open.length) return null;
  return (
    <div className="mt-3 space-y-2">
      {open.slice(0, 5).map((p) => (
        <button key={p.id} onClick={() => onOpen(p.id)} className={`block w-full rounded-2xl border p-3 text-left text-sm ${p.can_answer ? 'border-warn/50' : 'border-line'} bg-panel`}>
          <span className="font-medium">{p.title}{p.from ? ` with ${p.from}` : p.with ? ` with ${p.with.map((w) => w.name).join(', ')}` : ''}</span>
          <span className="block text-xs text-muted">{p.booked ? `Set: ${p.booked.when}${p.booked.place ? ` at ${p.booked.place}` : ''}` : p.can_answer ? 'Waiting for your answer' : p.status.replace(/_/g, ' ')}</span>
        </button>
      ))}
    </div>
  );
}
