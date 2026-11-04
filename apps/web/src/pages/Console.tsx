import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { Button, Panel } from '../components/ui.tsx';

// No-code partner console: offers through a form, anonymous matches, requests. Every call goes through the
// public Partner API (server: http/console.ts forwards a whitelist of calls with the partner's own token).

interface Offer { id: string; type: string; title: string; description: string; link: string | null; countries: string[]; valid_until: string | null; status: string }
interface Match { twin_id: string; score: number; reason: string }
interface Req { id: string; kind: string; status: string; offer_id: string | null; twin_id: string; created_at: string }
const KINDS: [string, string][] = [['schedule', 'Meeting'], ['share_contact', 'Contact details'], ['share_cv', 'CV'], ['custom', 'Something else']];

function call<T>(slug: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  return api<T>(`/console/${slug}/api`, { body: { method, path, ...(body !== undefined ? { body } : {}) } });
}

export function Console() {
  const { slug } = useParams();
  const [mine, setMine] = useState<{ slug: string; name: string; operator_affiliated: boolean }[] | null>(null);
  useEffect(() => { api<{ partners: { slug: string; name: string; operator_affiliated: boolean }[] }>('/console').then((r) => setMine(r.partners)).catch(() => setMine([])); }, []);
  if (!slug) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
        <h1 className="text-2xl font-semibold">Partner console</h1>
        {mine === null ? <p className="text-muted">Loading…</p> : !mine.length
          ? <p className="text-muted">You’re not a member of a partner yet. Apply on <Link to="/developers" className="underline">/developers</Link>.</p>
          : mine.map((p) => <Link key={p.slug} to={`/console/${p.slug}`} className="block rounded-2xl border border-line bg-panel p-4 hover:border-white/40">{p.name}</Link>)}
      </div>
    );
  }
  return <PartnerConsole slug={slug} name={mine?.find((p) => p.slug === slug)?.name ?? slug} />;
}

function PartnerConsole({ slug, name }: { slug: string; name: string }) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [requests, setRequests] = useState<Req[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    call<{ offers: Offer[] }>(slug, 'GET', '/offers').then((r) => setOffers(r.offers)).catch((e) => setError(e instanceof ApiError ? e.message : 'Couldn’t load.'));
    call<{ requests: Req[] }>(slug, 'GET', '/requests').then((r) => setRequests(r.requests)).catch(() => {});
  }, [slug]);
  useEffect(load, [load]);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const until = String(f.get('until') || '');
    setError(null);
    try {
      await call(slug, 'POST', '/offers', {
        type: f.get('type'), title: f.get('title'), description: f.get('description'),
        ...(f.get('link') ? { link: f.get('link') } : {}), ...(f.get('location') ? { location: f.get('location') } : {}),
        countries: String(f.get('countries') || '').split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean),
        ...(until ? { valid_until: new Date(`${until}T23:59:00`).toISOString() } : {}),
      });
      e.currentTarget.reset();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}` : 'Couldn’t publish it.');
    }
  };
  const input = 'w-full rounded-xl border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-rim/60';

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5 px-4 py-6 lg:grid-cols-[1fr_1.3fr] [&>*]:min-w-0">
      <div className="space-y-5">
        <h1 className="text-2xl font-semibold">{name} · console</h1>
        <p className="text-sm text-muted">Everything here uses the public Partner API with your partner’s own permissions. People stay anonymous until they say yes to a request.</p>
        <Panel title="New offer">
          <form onSubmit={create} className="space-y-2">
            <select name="type" className={input} defaultValue="deal">
              <option value="deal">Deal</option><option value="event">Event</option><option value="service">Service</option><option value="job">Job</option>
            </select>
            <input name="title" required minLength={3} placeholder="Title" className={input} />
            <textarea name="description" required minLength={10} rows={3} placeholder="Description" className={input} />
            <input name="link" type="url" placeholder="Link (https://…)" className={input} />
            <div className="grid grid-cols-2 gap-2">
              <input name="countries" placeholder="Countries, e.g. TN DE" className={input} />
              <input name="location" placeholder="Place or city" className={input} />
            </div>
            <label className="block text-xs text-muted">Valid until<input name="until" type="date" className={`${input} mt-1`} /></label>
            {error && <p className="text-sm text-bad">{error}</p>}
            <Button className="w-full">Publish</Button>
          </form>
        </Panel>
        <Panel title="Requests" aside={<span className="text-xs text-muted">{requests.length}</span>}>
          {!requests.length ? <p className="text-sm text-muted">No requests yet.</p> : requests.map((r) => <RequestRow key={r.id} slug={slug} r={r} />)}
        </Panel>
      </div>
      <div className="space-y-4">
        {offers.map((o) => <OfferCard key={o.id} slug={slug} offer={o} onChange={load} />)}
        {!offers.length && <p className="text-sm text-muted">No offers yet: publish one on the left.</p>}
      </div>
    </div>
  );
}

function OfferCard({ slug, offer: o, onChange }: { slug: string; offer: Offer; onChange(): void }) {
  const [matches, setMatches] = useState<Match[] | null>(null);
  return (
    <Panel title={o.title} aside={<span className="text-xs text-muted">{o.type} · {o.status}</span>}>
      <p className="break-words text-sm text-white/80">{o.description}</p>
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        <button className="underline" onClick={async () => setMatches((await call<{ matches: Match[] }>(slug, 'GET', `/offers/${o.id}/matches`)).matches)}>See matches</button>
        {o.status === 'open' && <button className="text-bad" onClick={async () => { await call(slug, 'PATCH', `/offers/${o.id}`, { status: 'closed' }).catch(() => {}); onChange(); }}>Close</button>}
      </div>
      {matches && (matches.length ? matches.map((m) => <MatchRow key={m.twin_id} slug={slug} offerId={o.id} m={m} />)
        : <p className="mt-2 text-sm text-muted">No matches yet. People see offers only from partners they activated.</p>)}
    </Panel>
  );
}

function MatchRow({ slug, offerId, m }: { slug: string; offerId: string; m: Match }) {
  const [conv, setConv] = useState<string | null>(null);
  const [said, setSaid] = useState<{ who: 'you' | 'twin'; text: string }[]>([]);
  const [text, setText] = useState('');
  const [kind, setKind] = useState('schedule');
  const [note, setNote] = useState<string | null>(null);
  const ask = async () => {
    const q = text.trim();
    if (!q) return;
    setText('');
    setSaid((s) => [...s, { who: 'you', text: q }]);
    let id = conv;
    if (!id) {
      id = (await call<{ conversation: { id: string } }>(slug, 'POST', `/twins/${m.twin_id}/conversations`, { offer_id: offerId })).conversation.id;
      setConv(id);
    }
    const r = await call<{ reply: string }>(slug, 'POST', `/conversations/${id}/messages`, { text: q }).catch((e) => ({ reply: e instanceof ApiError ? e.message : 'Couldn’t reach the twin.' }));
    setSaid((s) => [...s, { who: 'twin', text: r.reply }]);
  };
  const request = async () => {
    const slot = new Date(Date.now() + 2 * 86_400_000);
    slot.setUTCHours(9, 0, 0, 0);
    const body = { kind, offer_id: offerId, ...(kind === 'schedule' ? { slots: [slot.toISOString()] } : {}), ...(kind === 'custom' ? { text: 'Could we talk about this offer?' } : {}) };
    const r = await call<{ request: { status: string } }>(slug, 'POST', `/twins/${m.twin_id}/requests`, body).catch((e) => ({ request: { status: e instanceof ApiError ? e.message : 'failed' } }));
    setNote(`Request sent: ${r.request.status}. The person decides.`);
  };
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-line p-3 text-sm">
      <p><span className="font-mono text-xs text-muted">{m.twin_id}</span> · score {m.score}</p>
      <p className="text-xs text-muted">{m.reason}</p>
      {said.map((x, i) => <p key={i} className={x.who === 'you' ? 'text-right' : 'text-white/85'}>{x.text}</p>)}
      <div className="flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask this twin…" className="min-w-0 flex-1 rounded-full border border-line bg-ink px-3 py-1.5 outline-none" />
        <Button variant="ghost" onClick={() => void ask()}>Ask</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-full border border-line bg-ink px-2 py-1">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <Button variant="ghost" onClick={() => void request()}>Send request</Button>
      </div>
      {note && <p className="text-xs text-muted">{note}</p>}
    </div>
  );
}

function RequestRow({ slug, r }: { slug: string; r: Req }) {
  const [shared, setShared] = useState<unknown>(null);
  return (
    <div className="border-b border-line/60 py-2 text-sm last:border-0">
      <p>{KINDS.find(([k]) => k === r.kind)?.[1] ?? r.kind} · <span className={r.status === 'approved' ? 'text-ok' : r.status === 'declined' ? 'text-bad' : 'text-muted'}>{r.status}</span> <span className="font-mono text-xs text-muted">{r.twin_id}</span></p>
      {r.status === 'approved' && !shared && (
        <button className="text-xs underline" onClick={async () => setShared((await call<{ request: { shared?: unknown } }>(slug, 'GET', `/requests/${r.id}`)).request.shared ?? 'Already delivered (shared data is handed over once).')}>Open what they shared</button>
      )}
      {shared != null && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-white/80">{typeof shared === 'string' ? shared : JSON.stringify(shared, null, 2)}</pre>}
    </div>
  );
}
