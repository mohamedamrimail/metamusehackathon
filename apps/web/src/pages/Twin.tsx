import { AGE_RANGES, GENDERS } from '@ipersons/shared';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money, type Fact, type Wallet } from '../api.ts';
import { AvatarStudio } from '../avatar/AvatarStudio.tsx';
import { LinksEditor, RulesEditor, SourcesPicker } from '../components/Setup.tsx';
import { InsightsCard } from '../components/Insights.tsx';
import { OffersPanel } from '../components/Offers.tsx';
import { PeoplePanel } from '../components/People.tsx';
import { PendingMemoryPanel } from '../components/PendingMemory.tsx';
import { FeedbackForm } from '../components/Feedback.tsx';
import { TimeGivenBackPanel } from '../components/Impact.tsx';
import { ChainCard } from '../components/Growth.tsx';
import { PublicLinkPanel } from '../components/PublicLink.tsx';
import { PrivacyPanel } from '../components/Discoverability.tsx';
import { GlassesPanel } from '../components/GlassesPanel.tsx';
import { Button, Chip, Panel } from '../components/ui.tsx';
import { useSession } from '../session.tsx';

const CATEGORIES = ['preference', 'routine', 'goal', 'constraint', 'contact'] as const;
interface Position { symbol: string; qty: number; avg_price: number; last_price: number; unrealized_pnl: number }
interface Connection { id: string; kind: string; config: { url?: string; name?: string | null } }

export function Twin() {
  const { iperson, user } = useSession();
  // The mock wallet and paper trading only show when SHOW_SIMULATIONS is on (off in production).
  const id = iperson!.id;
  const [facts, setFacts] = useState<Fact[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [conns, setConns] = useState<Connection[]>([]);
  const [waPhone, setWaPhone] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [f, w, p, c] = await Promise.all([
      api<{ facts: Fact[] }>(`/ipersons/${id}/facts`),
      api<{ wallet: Wallet | null }>(`/ipersons/${id}/wallet`),
      api<{ positions: Position[] }>(`/ipersons/${id}/portfolio`),
      api<{ connections: Connection[]; whatsapp_phone: string | null }>(`/ipersons/${id}/connections`),
    ]);
    setFacts(f.facts);
    setWallet(w.wallet);
    setPositions(p.positions);
    setConns(c.connections);
    setWaPhone(c.whatsapp_phone);
  }, [id]);
  useEffect(() => void load(), [load]);

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5 px-4 py-6 lg:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
      <div className="space-y-5">
      <PendingMemoryPanel ipersonId={id} onChange={load} />
      <TimeGivenBackPanel verified={Boolean(user?.verified)} />
      <Panel title="Twin chain"><ChainCard /></Panel>
      <OffersPanel />
      <InsightsCard />
      <Panel title="What it knows about you" aside={<span className="text-xs text-muted">{facts.length} facts</span>}>
        <div className="space-y-5">
          {CATEGORIES.map((cat) => {
            const list = facts.filter((f) => f.category === cat && f.source !== 'mailbox');
            return (
              <div key={cat}>
                <h3 className="mb-2 text-xs uppercase tracking-wider text-muted">{cat}s</h3>
                {list.length ? list.map((f) => <FactRow key={f.id} fact={f} ipersonId={id} onChange={load} />)
                  : <p className="text-sm text-muted/60">Nothing yet.</p>}
              </div>
            );
          })}
          {facts.some((f) => f.source === 'mailbox') && (
            <div>
              <h3 className="mb-2 text-xs uppercase tracking-wider text-muted">Learned from your mailbox</h3>
              {facts.filter((f) => f.source === 'mailbox').map((f) => <FactRow key={f.id} fact={f} ipersonId={id} onChange={load} />)}
            </div>
          )}
          <AddFact ipersonId={id} onAdded={load} />
        </div>
      </Panel>
      <PeoplePanel />
      </div>

      <div className="space-y-5">
        {/* Your look first: the selfie → living twin is the first thing people try (and the jury demo's first scene). */}
        <AvatarStudio />
        <Panel title="My rules"><RulesEditor /></Panel>
        <Panel title="Where I look first"><SourcesPicker /></Panel>
        <Panel title="Profiles I learn from"><LinksEditor /></Panel>
        <Panel title="Glasses"><GlassesPanel /></Panel>
        <PublicLinkPanel />
        <PrivacyPanel />
        <CreditPanel />
        {user?.show_simulations && wallet && <WalletPanel ipersonId={id} wallet={wallet} onChange={setWallet} />}
        {user?.show_simulations && <Panel title="Paper portfolio" aside={<Chip tone="warn">Simulation</Chip>}>
          {positions.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="pb-2">Symbol</th><th>Qty</th><th>Avg</th><th className="text-right">P&L (USD)</th></tr></thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol} className="border-t border-line">
                    <td className="py-2 font-medium">{p.symbol}</td><td>{p.qty}</td><td>{p.avg_price.toFixed(2)}</td>
                    <td className={`text-right ${p.unrealized_pnl >= 0 ? 'text-ok' : 'text-bad'}`}>{p.unrealized_pnl >= 0 ? '+' : ''}{p.unrealized_pnl.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-sm text-muted">No positions. Ask your i-person to paper-trade — it's simulated, no real money.</p>}
        </Panel>}
        <ScanPanel ipersonId={id} />
        <Panel title="Connections">
          <div className="space-y-3 text-sm">
            <Row label="Calendar" value="Demo calendar" note="Google Calendar coming soon" />
            <Row label="Email" value="contact@i-persons.com" note="Every sent email is logged in Activity" />
            <WhatsAppRow ipersonId={id} phone={waPhone} onChange={load} />
            {conns.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2">
                <span className="truncate">MCP · {c.config.name || c.config.url}</span>
                <button className="text-xs text-bad" onClick={async () => { await api(`/ipersons/${id}/connections/${c.id}`, { method: 'DELETE' }); void load(); }}>Remove</button>
              </div>
            ))}
            <form className="flex gap-2 pt-1" onSubmit={async (e) => {
              e.preventDefault();
              const url = String(new FormData(e.currentTarget).get('url'));
              await api(`/ipersons/${id}/connections`, { body: { kind: 'mcp', url } });
              e.currentTarget.reset();
              void load();
            }}>
              <input name="url" type="url" required placeholder="MCP server URL" className="min-w-0 flex-1 rounded-full border border-line bg-ink px-4 py-2 outline-none" />
              <Button variant="ghost">Add</Button>
            </form>
          </div>
        </Panel>
        <Panel title="Your feedback"><FeedbackForm context="twin" onDone={() => {}} /></Panel>
        <AboutYou />
        <DeleteAccount />
      </div>
    </div>
  );
}

interface Credit {
  billing: boolean; balance_usd: number; free_usd: number; fee_ratio: number;
  by_kind: { kind: string; calls: number; meta_usd: number; fee_usd: number }[];
}
const KIND_LABEL: Record<string, string> = { llm: 'Conversations', stt: 'Listening', tts: 'Speaking', image: 'Avatar images', sam: 'Face detection' };
const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

function CreditPanel() {
  const [c, setC] = useState<Credit | null>(null);
  useEffect(() => { api<Credit>('/me/credit').then(setC).catch(() => {}); }, []);
  if (!c?.billing) return null;
  const left = Math.max(0, c.balance_usd);
  const meta = c.by_kind.reduce((n, k) => n + k.meta_usd, 0);
  const fee = c.by_kind.reduce((n, k) => n + k.fee_usd, 0);
  const pct = c.free_usd > 0 ? Math.min(100, (left / c.free_usd) * 100) : 0;
  return (
    <Panel title="AI credit" aside={<span className={`text-sm font-medium ${left > 0 ? '' : 'text-bad'}`}>{usd(left)} left</span>}>
      <div className="h-2 overflow-hidden rounded-full bg-line" role="meter" aria-valuenow={left} aria-valuemin={0} aria-valuemax={c.free_usd} aria-label="AI credit left">
        <div className={`h-full rounded-full ${pct > 20 ? 'bg-white' : 'bg-bad'}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted">Every account starts with {usd(c.free_usd)} free. Conversations, voice and avatar images use it.</p>
      {c.by_kind.length > 0 && (
        <table className="mt-3 w-full text-sm">
          <tbody>
            {c.by_kind.map((k) => (
              <tr key={k.kind} className="border-t border-line">
                <td className="py-1.5">{KIND_LABEL[k.kind] ?? k.kind} <span className="text-xs text-muted">×{k.calls}</span></td>
                <td className="text-right tabular-nums">{usd(k.meta_usd + k.fee_usd)}</td>
              </tr>
            ))}
            <tr className="border-t border-line text-xs text-muted">
              <td className="pt-1.5">Spent so far: AI providers {usd(meta)} + platform {usd(fee)}</td>
              <td className="pt-1.5 text-right tabular-nums">{usd(meta + fee)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {left <= 0 && <p className="mt-3 text-sm text-bad">Your credit is used up. Top-ups are coming soon — write to contact@i-persons.com.</p>}
    </Panel>
  );
}

function AboutYou() {
  const { user, refresh } = useSession();
  const save = (body: object) => api('/me/profile', { method: 'PATCH', body }).then(refresh);
  const select = 'w-full rounded-full border border-line bg-ink px-3 py-2 outline-none';
  return (
    <Panel title="About you">
      <p className="mb-3 text-xs text-muted">Shapes your avatar and voice suggestions only. Never public, never given to your twin.</p>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <select aria-label="Gender" className={select} value={user?.gender ?? ''} onChange={(e) => void save({ gender: e.target.value })}>
          {GENDERS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
        </select>
        <select aria-label="Age" className={select} value={user?.age_range ?? ''} onChange={(e) => void save({ age_range: e.target.value })}>
          {AGE_RANGES.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
    </Panel>
  );
}

function DeleteAccount() {
  const { user, refresh } = useSession();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel title="Your data">
      <p className="text-sm text-muted">Delete your account, your i-person, its memory, conversations, photos and action history. This can't be undone. <a href="/privacy.html" className="underline">Privacy policy</a></p>
      {!open ? <Button variant="danger" className="mt-3 w-full" onClick={() => setOpen(true)}>Delete my account</Button> : (
        <form className="mt-3 flex gap-2" onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const typed = String(new FormData(e.currentTarget).get('password'));
            await api('/me', { method: 'DELETE', body: user?.has_password === false ? { confirm: typed } : { password: typed } });
            await refresh();
            nav('/');
          } catch {
            setError(user?.has_password === false ? 'Type DELETE to confirm.' : 'Wrong password.');
          }
        }}>
          <input name="password" type={user?.has_password === false ? 'text' : 'password'} required autoFocus placeholder={user?.has_password === false ? 'Type DELETE to confirm' : 'Your password to confirm'} className="min-w-0 flex-1 rounded-full border border-line bg-ink px-4 py-2 outline-none" />
          <Button variant="danger">Delete</Button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </Panel>
  );
}

function Row({ label, value, note }: { label: string; value: string | null; note: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <span className="text-right text-muted">{value ?? '—'} <span className="block text-xs text-muted/60">{note}</span></span>
    </div>
  );
}

function ScanPanel({ ipersonId }: { ipersonId: string }) {
  const [state, setState] = useState<string | null>(null);
  return (
    <Panel title="While you sleep">
      <p className="text-sm text-muted">Every 6 hours your i-person looks for deals and opportunities that match you, and tells you on WhatsApp.</p>
      <Button variant="ghost" className="mt-3 w-full" disabled={state === '…'} onClick={async () => {
        setState('…');
        const r = await api<{ sent: { title: string }[] }>(`/ipersons/${ipersonId}/scan`, { method: 'POST' });
        setState(r.sent.length ? `Found ${r.sent.length}: ${r.sent.map((i) => i.title).join('; ')}` : 'Nothing new right now.');
      }}>Look for opportunities now</Button>
      {state && state !== '…' && <p className="mt-2 text-sm">{state}</p>}
    </Panel>
  );
}

function WhatsAppRow({ ipersonId, phone, onChange }: { ipersonId: string; phone: string | null; onChange(): void }) {
  const [link, setLink] = useState<{ code: string; number: string | null; wa_link: string | null; enabled: boolean } | null>(null);
  if (phone) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span>WhatsApp</span>
        <span className="text-right">{phone} <button className="ml-2 text-xs text-bad" onClick={async () => { await api(`/ipersons/${ipersonId}/whatsapp`, { method: 'DELETE' }); onChange(); }}>Unlink</button></span>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <span>WhatsApp</span>
        {!link && <Button variant="ghost" className="px-3 py-1.5" onClick={async () => setLink(await api(`/ipersons/${ipersonId}/whatsapp/code`, { method: 'POST' }))}>Link my number</Button>}
      </div>
      {link && (
        <div className="mt-2 text-muted">
          {!link.enabled && <p className="mb-1 text-xs text-warn">WhatsApp isn't configured on the server yet.</p>}
          <p>Send <span className="font-mono text-white">VERIFY {link.code}</span> to {link.number ? `+${link.number}` : "your i-person's number"} on WhatsApp within 15 minutes.</p>
          {link.wa_link && <a href={link.wa_link} target="_blank" rel="noreferrer" className="mt-2 inline-block text-white underline">Open WhatsApp</a>}
          <button className="ml-3 text-xs underline" onClick={onChange}>I sent it</button>
        </div>
      )}
    </div>
  );
}

function FactRow({ fact, ipersonId, onChange }: { fact: Fact; ipersonId: string; onChange(): void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(fact.value);
  return (
    // Phones: topic, visibility and actions on one line, the fact full width below. Wider screens: one line.
    <div className="group flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-line/60 py-2 last:border-0 sm:flex-nowrap">
      <span className="min-w-0 flex-1 truncate pt-0.5 text-xs text-muted sm:w-28 sm:flex-none sm:shrink-0">{fact.key.replace(/_/g, ' ')}</span>
      {editing ? (
        <form className="order-last flex min-w-0 basis-full gap-2 sm:order-none sm:basis-auto sm:flex-1" onSubmit={async (e) => {
          e.preventDefault();
          await api(`/ipersons/${ipersonId}/facts/${fact.id}`, { method: 'PATCH', body: { value } });
          setEditing(false);
          onChange();
        }}>
          <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus className="min-w-0 flex-1 rounded-lg border border-line bg-ink px-2 py-1 text-sm outline-none" />
          <button className="text-xs">Save</button>
        </form>
      ) : (
        <span className="order-last min-w-0 basis-full break-words text-sm sm:order-none sm:basis-auto sm:flex-1">{fact.value}</span>
      )}
      {/* Phase 6a: private by default; public facts are what visitors and partners may hear. */}
      <button title={fact.visibility === 'public' ? 'Visible on your public page' : 'Only you and your twin'}
        onClick={async () => { await api(`/ipersons/${ipersonId}/facts/${fact.id}`, { method: 'PATCH', body: { visibility: fact.visibility === 'public' ? 'private' : 'public' } }); onChange(); }}
        className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${fact.visibility === 'public' ? 'border-rim/60 text-rim' : 'border-line text-muted'}`}>
        {fact.visibility === 'public' ? 'Public' : 'Private'}
      </button>
      <div className="flex shrink-0 gap-3 text-xs text-muted opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
        {!editing && <button onClick={() => setEditing(true)}>Edit</button>}
        <button className="text-bad" onClick={async () => { await api(`/ipersons/${ipersonId}/facts/${fact.id}`, { method: 'DELETE' }); onChange(); }}>Forget</button>
      </div>
    </div>
  );
}

function AddFact({ ipersonId, onAdded }: { ipersonId: string; onAdded(): void }) {
  return (
    <form className="flex flex-wrap gap-2 border-t border-line pt-4" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      await api(`/ipersons/${ipersonId}/facts`, { body: { category: f.get('category'), key: f.get('key'), value: f.get('value') } });
      e.currentTarget.reset();
      onAdded();
    }}>
      <select name="category" className="rounded-full border border-line bg-ink px-3 py-2 text-sm">
        {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
      </select>
      <input name="key" required placeholder="topic" className="w-28 rounded-full border border-line bg-ink px-3 py-2 text-sm outline-none" />
      <input name="value" required placeholder="what it should know" className="min-w-[12rem] flex-1 rounded-full border border-line bg-ink px-3 py-2 text-sm outline-none" />
      <Button variant="ghost">Teach</Button>
    </form>
  );
}

function WalletPanel({ ipersonId, wallet, onChange }: { ipersonId: string; wallet: Wallet; onChange(w: Wallet): void }) {
  const spent = wallet.spentMonth === new Date().toISOString().slice(0, 7) ? wallet.spentThisMonthCents : 0;
  const save = async (body: Record<string, number>) => {
    const r = await api<{ wallet: Wallet }>(`/ipersons/${ipersonId}/wallet`, { method: 'PATCH', body });
    onChange(r.wallet);
  };
  return (
    <Panel title="Wallet" aside={<Chip>Mock money</Chip>}>
      <p className="text-3xl font-semibold">{money(wallet.balanceCents, wallet.currency)}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
        <div className="h-full bg-white" style={{ width: `${Math.min(100, (spent / Math.max(wallet.monthlyBudgetCents, 1)) * 100)}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted">{money(spent, wallet.currency)} of {money(wallet.monthlyBudgetCents, wallet.currency)} monthly budget used</p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Limit label={`Per action (${wallet.currency})`} cents={wallet.perActionLimitCents} onSave={(c) => save({ per_action_limit_cents: c })} />
        <Limit label={`Monthly (${wallet.currency})`} cents={wallet.monthlyBudgetCents} onSave={(c) => save({ monthly_budget_cents: c })} />
      </div>
      <Button variant="ghost" className="mt-4 w-full" onClick={() => save({ topup_cents: 10_000 })}>Top up 100 {wallet.currency} (mock)</Button>
    </Panel>
  );
}

function Limit({ label, cents, onSave }: { label: string; cents: number; onSave(c: number): void }) {
  const [v, setV] = useState(String(cents / 100));
  useEffect(() => setV(String(cents / 100)), [cents]);
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      <input value={v} inputMode="decimal" onChange={(e) => setV(e.target.value)}
        onBlur={() => { const n = Number(v.replace(',', '.')); if (n >= 0 && Math.round(n * 100) !== cents) onSave(Math.round(n * 100)); }}
        className="w-full rounded-xl border border-line bg-ink px-3 py-2 outline-none" />
    </label>
  );
}
