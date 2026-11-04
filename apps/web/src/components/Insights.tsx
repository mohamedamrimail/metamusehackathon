import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Panel } from './ui.tsx';

// My twin → Insights (M4): grouped, with evidence and actions.

interface Insight { id: string; kind: string; title: string; body: string; group: 'travel' | 'shopping' | 'upcoming'; evidence: string }
interface Offer { title: string; why?: string; price?: string; when?: string; url?: string }
const GROUPS = [['upcoming', 'Upcoming', '📅'], ['travel', 'Travel', '✈️'], ['shopping', 'Shopping', '🛒']] as const;

export function InsightsCard() {
  const [list, setList] = useState<Insight[] | null>(null);
  const [similar, setSimilar] = useState<Record<string, Offer[] | 'loading' | 'none'>>({});
  const load = useCallback(() => api<{ insights: Insight[] }>('/insights').then((r) => setList(r.insights)).catch(() => setList([])), []);
  useEffect(() => void load(), [load]);
  if (!list?.length) return null;
  const act = async (id: string, what: 'dismiss' | 'wrong') => { await api(`/insights/${id}/${what}`, { method: 'POST' }); void load(); };

  return (
    <Panel title="Insights" aside={<span className="text-xs text-muted">from your orders and bookings</span>}>
      <div className="space-y-4">
        {GROUPS.map(([g, label, icon]) => {
          const items = list.filter((i) => i.group === g);
          if (!items.length) return null;
          return (
            <div key={g}>
              <h3 className="mb-2 text-xs uppercase tracking-wider text-muted">{label}</h3>
              <ul className="space-y-2">
                {items.map((i) => {
                  const s = similar[i.id];
                  return (
                    <li key={i.id} className="rounded-xl border border-line p-3 text-sm">
                      <p><span aria-hidden className="mr-1.5">{icon}</span><strong>{i.title}</strong> <span className="text-muted">{i.body}</span></p>
                      <p className="mt-1 text-xs text-muted">{i.evidence}</p>
                      <div className="mt-2 flex gap-3 text-xs">
                        {i.kind !== 'upcoming' && <button className="underline" disabled={s === 'loading'} onClick={async () => {
                          setSimilar((x) => ({ ...x, [i.id]: 'loading' }));
                          const r = await api<{ items: Offer[] }>(`/insights/${i.id}/similar`, { method: 'POST' }).catch(() => ({ items: [] }));
                          setSimilar((x) => ({ ...x, [i.id]: r.items.length ? r.items : 'none' }));
                        }}>{s === 'loading' ? 'Searching…' : 'Find similar'}</button>}
                        <button className="text-muted" onClick={() => void act(i.id, 'dismiss')}>Dismiss</button>
                        <button className="text-bad" onClick={() => void act(i.id, 'wrong')}>This is wrong</button>
                      </div>
                      {Array.isArray(s) && (
                        <ul className="mt-2 space-y-1 border-t border-line pt-2 text-xs">
                          {s.map((o) => <li key={o.title}>{o.url ? <a href={o.url} target="_blank" rel="noreferrer" className="underline">{o.title}</a> : o.title}{o.price ? ` · ${o.price}` : ''}</li>)}
                        </ul>
                      )}
                      {s === 'none' && <p className="mt-2 text-xs text-muted">Nothing reliable found right now.</p>}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
