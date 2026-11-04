import type { PendingMemoryItem } from '@ipersons/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';

// Facts and rules the twin learned right after reading outside content (web, emails…): nothing is
// remembered until the user keeps it. Shown on Talk (as they come) and on My twin.

export function usePendingMemory(ipersonId: string | undefined) {
  const [items, setItems] = useState<PendingMemoryItem[]>([]);
  const load = useCallback(() => {
    if (ipersonId) api<{ items: PendingMemoryItem[] }>(`/ipersons/${ipersonId}/memory/pending`).then((r) => setItems(r.items)).catch(() => {});
  }, [ipersonId]);
  useEffect(load, [load]);
  const decide = useCallback(async (item: PendingMemoryItem, keep: boolean) => {
    setItems((list) => list.filter((x) => x.id !== item.id));
    await api(`/ipersons/${ipersonId}/memory/pending/${item.kind}/${item.id}`, { body: { keep } }).catch(() => {});
  }, [ipersonId]);
  return { items, load, decide, add: (more: PendingMemoryItem[]) => setItems((list) => [...list.filter((x) => !more.some((m) => m.id === x.id)), ...more]) };
}

export function PendingMemoryCard({ item, onDecide }: { item: PendingMemoryItem; onDecide(item: PendingMemoryItem, keep: boolean): void }) {
  return (
    <div className="pointer-events-auto w-full rounded-2xl border border-warn/40 bg-panel/95 p-4 text-sm shadow-lg backdrop-blur">
      <p className="text-xs uppercase tracking-wider text-warn">Keep this {item.kind}?</p>
      <p className="mt-1 text-muted">I learned this after reading {item.source}:</p>
      <p className="mt-1 break-words">“{item.text}”</p>
      <div className="mt-3 flex gap-2">
        <button onClick={() => onDecide(item, false)} className="flex-1 rounded-full border border-line py-2">Discard</button>
        <button onClick={() => onDecide(item, true)} className="flex-1 rounded-full bg-white py-2 font-medium text-black">Keep</button>
      </div>
    </div>
  );
}

/** My twin: everything still waiting, with Keep / Discard. Hidden when there is nothing. */
export function PendingMemoryPanel({ ipersonId, onChange }: { ipersonId: string; onChange?(): void }) {
  const { items, decide } = usePendingMemory(ipersonId);
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs uppercase tracking-wider text-warn">Waiting for your OK</h2>
      {items.map((i) => <PendingMemoryCard key={i.id} item={i} onDecide={async (x, keep) => { await decide(x, keep); onChange?.(); }} />)}
    </section>
  );
}
