import { PartnerActivity, VisitorActivity } from '../components/Offers.tsx';
import { useCallback, useEffect, useState } from 'react';
import { api, money, type Action } from '../api.ts';
import { Button, Chip } from '../components/ui.tsx';
import { useSession } from '../session.tsx';

const TONE: Record<Action['status'], 'muted' | 'ok' | 'warn' | 'bad' | 'rim'> = {
  proposed: 'rim', confirmed: 'warn', done: 'ok', failed: 'bad', rejected: 'muted', expired: 'muted',
};
const LABEL: Record<Action['status'], string> = {
  proposed: 'Waiting for you', confirmed: 'Running', done: 'Done', failed: 'Failed', rejected: 'Declined', expired: 'Expired',
};

export function Activity() {
  const { iperson } = useSession();
  const [actions, setActions] = useState<Action[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | Action['status']>('all');

  const load = useCallback(async () => {
    const r = await api<{ actions: Action[] }>(`/ipersons/${iperson!.id}/actions`);
    setActions(r.actions);
  }, [iperson]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const list = (actions ?? []).filter((a) => filter === 'all' || a.status === filter);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="mb-5 space-y-5"><VisitorActivity /><PartnerActivity /></div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Activity</h1>
          <p className="text-sm text-muted">Everything your i-person proposed and did. Nothing runs without your yes.</p>
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="rounded-full border border-line bg-panel px-3 py-2 text-sm">
          <option value="all">All</option>
          {(Object.keys(LABEL) as Action['status'][]).map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
        </select>
      </div>
      {actions === null ? <p className="text-muted">Loading…</p> : !list.length ? <p className="text-muted">Nothing here yet. Ask your i-person to do something.</p> : (
        <ol className="relative space-y-3 border-l border-line pl-5">
          {list.map((a) => (
            <li key={a.id} className="relative">
              <span className={`absolute -left-[25px] top-4 h-2.5 w-2.5 rounded-full ${a.status === 'done' ? 'bg-ok' : a.status === 'failed' ? 'bg-bad' : a.status === 'proposed' ? 'bg-rim' : 'bg-line'}`} />
              <div className="rounded-2xl border border-line bg-panel p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={TONE[a.status]}>{LABEL[a.status]}</Chip>
                  {a.risk === 'money' && <Chip tone="warn">{a.tool === 'paper_trade' ? 'Simulation' : 'Payment'}</Chip>}
                  <span className="ml-auto text-xs text-muted">{new Date(a.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-2 font-medium">{a.summary}</p>
                {a.amountCents != null && a.currency && <p className="text-sm text-muted">{money(a.amountCents, a.currency)}</p>}
                {a.status === 'proposed' && (
                  <div className="mt-3 flex gap-2">
                    <Button variant="ghost" onClick={async () => { await api(`/actions/${a.id}/reject`, { method: 'POST' }); void load(); }}>Decline</Button>
                    <Button onClick={async () => { await api(`/actions/${a.id}/confirm`, { method: 'POST' }).catch(() => {}); void load(); }}>Approve</Button>
                  </div>
                )}
                {a.result != null && (
                  <button className="mt-2 text-xs text-muted underline" onClick={() => setOpen(open === a.id ? null : a.id)}>
                    {open === a.id ? 'Hide details' : 'Details'}
                  </button>
                )}
                {open === a.id && <pre className="mt-2 overflow-x-auto rounded-xl bg-ink p-3 text-xs text-muted whitespace-pre-wrap">{JSON.stringify(a.result, null, 2)}</pre>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
