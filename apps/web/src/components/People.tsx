import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Panel } from './ui.tsx';

// People the twin knows: the address book and (opt-in) who the user emails with. Private to the owner.

interface Person { id: string; name: string; relationship: string | null; label: string | null; notes: string | null; emails: string[]; birthday: string | null; in_address_book: boolean; mails: number }
const GROUPS: [string, string][] = [['family', 'Family'], ['friend', 'Friends'], ['colleague', 'Colleagues'], ['client', 'Clients'], ['business', 'Business'], ['other', 'Others']];
const SHOWN = 8;

export function PeoplePanel() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [all, setAll] = useState(false);
  const load = useCallback(() => api<{ contacts: Person[] }>('/me/contacts').then((r) => setPeople(r.contacts)).catch(() => setPeople([])), []);
  useEffect(() => void load(), [load]);
  if (!people) return null;
  const known = people.filter((p) => p.relationship);
  const book = people.filter((p) => !p.relationship);
  return (
    <Panel title="People I know" aside={<span className="text-xs text-muted">{people.length}</span>}>
      {!people.length ? (
        <p className="text-sm text-muted">Nobody yet. Connect your mailbox in the <a href="/store" className="underline">Store</a> and turn on “Learn who I know”: your twin learns your family, friends and colleagues, and syncs your contacts and calendar.</p>
      ) : (
        <div className="space-y-4 text-sm">
          {GROUPS.map(([key, title]) => {
            const list = known.filter((p) => p.relationship === key);
            if (!list.length) return null;
            return (
              <div key={key}>
                <h3 className="mb-1.5 text-xs uppercase tracking-wider text-muted">{title}</h3>
                {(all ? list : list.slice(0, SHOWN)).map((p) => (
                  <div key={p.id} className="flex items-start gap-3 border-b border-line/60 py-2 last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="break-words"><strong>{p.name}</strong>{p.label && <span className="text-muted"> · {p.label}</span>}</p>
                      {p.notes && <p className="break-words text-xs text-muted">{p.notes}</p>}
                    </div>
                    <button className="shrink-0 text-xs text-bad" onClick={async () => { await api(`/me/contacts/${p.id}`, { method: 'DELETE' }); void load(); }}>Forget</button>
                  </div>
                ))}
                {!all && list.length > SHOWN && <button className="text-xs underline" onClick={() => setAll(true)}>Show all {list.length}</button>}
              </div>
            );
          })}
          {book.length > 0 && <p className="text-xs text-muted">Plus {book.length} more from your address book.</p>}
        </div>
      )}
    </Panel>
  );
}
