import { useCallback, useEffect, useMemo, useState } from 'react';
import { TwinsAdmin } from '../components/TwinsAdmin.tsx';
import { api, ApiError } from '../api.ts';
import { Button, Panel } from '../components/ui.tsx';

// Admin panel (Part C, more areas later). Only emails in ADMIN_EMAILS get past /admin/me.

const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'ZZ', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'XA', 'XB', 'CQ']);
/** Every ISO 3166-1 alpha-2 region the browser can name (no hard-coded list to maintain). */
function allCountries(): { code: string; name: string }[] {
  const dn = new Intl.DisplayNames(['en'], { type: 'region' });
  const out: { code: string; name: string }[] = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    if (NOT_COUNTRIES.has(code)) continue;
    try {
      const name = dn.of(code);
      if (name && name !== code) out.push({ code, name });
    } catch { /* not a region */ }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

type Tab = 'users' | 'gifts' | 'metrics' | 'feedback' | 'reports' | 'settings' | 'countries' | 'services' | 'partners' | 'invites' | 'bypass' | 'twins';

export function Admin() {
  const [ok, setOk] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('users');
  useEffect(() => { api('/admin/me').then(() => setOk(true)).catch(() => setOk(false)); }, []);
  if (ok === null) return <p className="p-6 text-muted">Loading…</p>;
  if (!ok) return <p className="p-6 text-muted">This area is for i-persons admins.</p>;
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap gap-1">
        {(['users', 'gifts', 'metrics', 'feedback', 'reports', 'settings', 'countries', 'services', 'partners', 'invites', 'bypass', 'twins'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1.5 text-sm capitalize ${tab === t ? 'bg-white text-black' : 'text-muted hover:text-white'}`}>{t}</button>
        ))}
      </div>
      {tab === 'countries' && <><Countries /><WaitlistGrowth /></>}
      {tab === 'services' && <Services />}
      {tab === 'partners' && <Partners />}
      {tab === 'invites' && <Invites />}
      {tab === 'bypass' && <Bypass />}
      {tab === 'metrics' && <><Summary /><GrowthAdmin /><ImpactAdmin /><Daily /><Latency /><Metrics /></>}
      {tab === 'feedback' && <FeedbackList />}
      {tab === 'users' && <Users />}
      {tab === 'gifts' && <><GiftsAdmin /><FamiliesAdmin /></>}
      {tab === 'reports' && <Reports />}
      {tab === 'settings' && <Settings />}
      {tab === 'twins' && <TwinsAdmin />}
    </div>
  );
}

interface CountrySettings { allowed: string[]; publicPagesWorldwide: boolean; existingUsersKeepAccess: boolean }

function Countries() {
  const all = useMemo(allCountries, []);
  const [s, setS] = useState<CountrySettings | null>(null);
  const [waiting, setWaiting] = useState<{ country: string | null; count: number }[]>([]);
  const [q, setQ] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => api<{ settings: CountrySettings; waitlist: typeof waiting }>('/admin/countries').then((r) => { setS(r.settings); setWaiting(r.waitlist); }), []);
  useEffect(() => void load(), [load]);
  if (!s) return null;
  const save = async (patch: Partial<CountrySettings>) => setS((await api<{ settings: CountrySettings }>('/admin/countries', { method: 'PUT', body: patch })).settings);
  const waitingIn = (c: string) => waiting.find((w) => w.country === c)?.count ?? 0;
  const shown = all.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.code === q.toUpperCase());

  return (
    <Panel title="Countries" aside={<span className="text-xs text-muted">{s.allowed.length} allowed</span>}>
      <div className="mb-3 space-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" className="accent-white" checked={s.publicPagesWorldwide} onChange={(e) => void save({ publicPagesWorldwide: e.target.checked })} />Public twin pages visible worldwide</label>
        <p className="text-xs text-muted">Existing accounts sign in from anywhere; the allowlist (and beta approval) applies to new sign-ups only.</p>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search countries…" className="mb-3 w-full rounded-full border border-line bg-ink px-4 py-2 outline-none" />
      {note && <p className="mb-2 text-sm">{note}</p>}
      <ul className="max-h-[28rem] divide-y divide-line overflow-y-auto">
        {shown.map((c) => {
          const on = s.allowed.includes(c.code);
          const n = waitingIn(c.code);
          return (
            <li key={c.code} className="flex items-center justify-between gap-2 py-2 text-sm">
              <label className="flex flex-1 items-center gap-3">
                <input type="checkbox" className="accent-white" checked={on} onChange={() => void save({ allowed: on ? s.allowed.filter((x) => x !== c.code) : [...s.allowed, c.code] })} />
                <span>{c.name} <span className="text-xs text-muted">{c.code}</span></span>
              </label>
              {n > 0 && (on
                ? <button className="text-xs underline" onClick={async () => {
                    try {
                      const r = await api<{ sent: number; of: number }>('/admin/waitlist/notify', { body: { country: c.code } });
                      setNote(`Emailed ${r.sent} of ${r.of} people waiting in ${c.name}.`);
                      void load();
                    } catch (err) { setNote(err instanceof ApiError ? err.message : 'Failed'); }
                  }}>Email the {n} waiting</button>
                : <span className="text-xs text-muted">{n} waiting</span>)}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

interface Invite { code: string; note: string | null; kind: string; cohort: string | null; maxUses: number; uses: number; expiresAt: string | null }

function Invites() {
  const [list, setList] = useState<Invite[]>([]);
  const load = useCallback(() => api<{ invites: Invite[] }>('/admin/invites').then((r) => setList(r.invites)), []);
  useEffect(() => void load(), [load]);
  return (
    <Panel title="Invite codes" aside={<span className="text-xs text-muted">bypass the country check at sign-up</span>}>
      <form className="mb-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-[1fr_6rem_6rem_8rem_7rem_auto]" onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await api('/admin/invites', { body: { note: f.get('note') || undefined, max_uses: Number(f.get('uses') || 1), expires_days: f.get('days') ? Number(f.get('days')) : undefined, cohort: f.get('cohort') || undefined, kind: f.get('kind') || 'invite' } });
        e.currentTarget.reset();
        void load();
      }}>
        <input name="note" placeholder="Note" className="rounded-full border border-line bg-ink px-3 py-2 outline-none" />
        <input name="uses" type="number" min={1} placeholder="Uses" className="rounded-full border border-line bg-ink px-3 py-2 outline-none" />
        <input name="days" type="number" min={1} placeholder="Days" className="rounded-full border border-line bg-ink px-3 py-2 outline-none" />
        <input name="cohort" pattern="[a-z0-9-]{2,40}" placeholder="cohort" className="rounded-full border border-line bg-ink px-3 py-2 outline-none" />
        <select name="kind" className="rounded-full border border-line bg-ink px-3 py-2"><option value="invite">Invite</option><option value="session">Session (QR)</option><option value="judge">Judges</option></select>
        <Button>Create</Button>
      </form>
      <ul className="divide-y divide-line text-sm">
        {list.map((i) => (
          <li key={i.code} className="flex items-center justify-between gap-2 py-2">
            <span><code className="rounded bg-ink px-1.5 py-0.5">{i.code}</code> {i.kind === 'judge' && <span className="rounded-full border border-warn/50 px-1.5 text-xs text-warn">judges</span>}{i.cohort && <span className="ml-1 rounded-full border border-line px-1.5 text-xs text-muted">{i.cohort}</span>}{i.kind === 'session' && <a href={`/s/${i.code}`} target="_blank" rel="noreferrer" className="ml-1 text-xs underline">session page</a>} <span className="text-muted">{i.note}</span></span>
            <span className="text-xs text-muted">{i.uses}/{i.maxUses} used{i.expiresAt ? ` · until ${new Date(i.expiresAt).toLocaleDateString()}` : ''}
              <button className="ml-3 underline" onClick={async () => {
                const days = prompt('Valid for how many more days? (0 = ends now, empty = no expiry)', i.expiresAt ? '' : '7');
                if (days === null) return;
                await api(`/admin/invites/${i.code}`, { method: 'PATCH', body: { expires_at: days.trim() === '' ? null : new Date(Date.now() + Number(days) * 86_400_000).toISOString() } });
                void load();
              }}>Expiry</button>
              <button className="ml-3 text-bad" onClick={async () => { await api(`/admin/invites/${i.code}`, { method: 'DELETE' }); void load(); }}>Delete</button></span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Bypass() {
  const [list, setList] = useState<{ email: string; note: string | null }[]>([]);
  const load = useCallback(() => api<{ emails: typeof list }>('/admin/bypass').then((r) => setList(r.emails)), []);
  useEffect(() => void load(), [load]);
  return (
    <Panel title="Bypass emails" aside={<span className="text-xs text-muted">may sign up from any country</span>}>
      <form className="mb-4 flex gap-2 text-sm" onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await api('/admin/bypass', { body: { email: f.get('email'), note: f.get('note') || undefined } });
        e.currentTarget.reset();
        void load();
      }}>
        <input name="email" type="email" required placeholder="Email" className="min-w-0 flex-1 rounded-full border border-line bg-ink px-3 py-2 outline-none" />
        <input name="note" placeholder="Note" className="w-32 rounded-full border border-line bg-ink px-3 py-2 outline-none" />
        <Button>Add</Button>
      </form>
      <ul className="divide-y divide-line text-sm">
        {list.map((b) => (
          <li key={b.email} className="flex justify-between py-2">
            <span>{b.email} <span className="text-muted">{b.note}</span></span>
            <button className="text-xs text-bad" onClick={async () => { await api(`/admin/bypass/${encodeURIComponent(b.email)}`, { method: 'DELETE' }); void load(); }}>Remove</button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Totals since launch, real users only (judges, demo and admins excluded): the README "Traction" numbers. */
function Summary() {
  const [m, setM] = useState<Record<string, number> | null>(null);
  useEffect(() => { api<{ summary: Record<string, number> }>('/admin/metrics/summary').then((r) => setM(r.summary)).catch(() => {}); }, []);
  if (!m) return null;
  return (
    <Panel title="Totals since launch" aside={<span className="text-xs text-muted">real users only</span>}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        {Object.entries(m).map(([k, v]) => <p key={k} className="flex justify-between gap-2 border-b border-line/50 py-1"><span className="text-muted">{k.replace(/_/g, ' ')}</span><span className="tabular-nums">{v}</span></p>)}
      </div>
    </Panel>
  );
}

/** Impact §1: hours given back (real users), by action type, with editable estimates and the landing toggle. */
/** Growth §2: viral coefficient and conversions, overall and per cohort, plus the twin chain challenge. */
function GrowthAdmin() {
  type G = Record<string, number>;
  const [d, setD] = useState<{ overall: G; by_cohort: Record<string, G>; chain: { started: string; completed: string } } | null>(null);
  const [days, setDays] = useState(30);
  useEffect(() => { api<NonNullable<typeof d>>(`/admin/growth?days=${days}`).then(setD).catch(() => {}); }, [days]);
  if (!d) return null;
  const cols: [string, string][] = [['invites_sent', 'Invites'], ['invites_per_inviting_user', 'Per inviter'], ['invite_to_signup_pct', 'Invite→sign-up %'], ['signup_to_verified_pct', 'Sign-up→verified %'], ['k', 'k'], ['users_with_connected_twin_pct', 'Connected %'], ['plans_booked', 'Plans booked']];
  const rows: [string, G][] = [['All', d.overall], ...Object.entries(d.by_cohort)];
  return (
    <Panel title="Growth" aside={<select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-full border border-line bg-ink px-2 py-1 text-xs">{[7, 30, 90, 0].map((n) => <option key={n} value={n}>{n ? `${n} days` : 'All time'}</option>)}</select>}>
      <div className="overflow-x-auto"><table className="w-full text-xs">
        <thead className="text-left text-muted"><tr><th className="pb-1">Cohort</th>{cols.map(([, l]) => <th key={l} className="pb-1 text-right">{l}</th>)}</tr></thead>
        <tbody>{rows.map(([c, g]) => <tr key={c} className="border-t border-line"><td className="py-1">{c}</td>{cols.map(([k]) => <td key={k} className="text-right tabular-nums">{g[k] ?? 0}</td>)}</tr>)}</tbody>
      </table></div>
      <p className="mt-2 text-xs text-muted">k = verified invitees ÷ users who invited. Twin chain: {d.chain.started} started, {d.chain.completed} completed.</p>
    </Panel>
  );
}

function ImpactAdmin() {
  const [d, setD] = useState<{ total_minutes: number; period_minutes: number; by_kind: Record<string, { count: number; minutes: number }>; estimates: { kind: string; label: string; minutes: number; justification: string }[] } | null>(null);
  const [counter, setCounter] = useState(false);
  const load = useCallback(() => {
    api<NonNullable<typeof d>>('/admin/impact?days=7').then(setD).catch(() => {});
    api<{ settings: { showImpactCounter?: boolean } }>('/admin/settings').then((r) => setCounter(Boolean(r.settings.showImpactCounter))).catch(() => {});
  }, []);
  useEffect(load, [load]);
  if (!d) return null;
  const h = (m: number) => `${(m / 60).toFixed(1)} h`;
  return (
    <Panel title="Time given back" aside={<span className="text-sm">{h(d.total_minutes)} total · {h(d.period_minutes)} last 7 days</span>}>
      <table className="w-full text-sm"><tbody>
        {d.estimates.map((e) => (
          <tr key={e.kind} className="border-t border-line">
            <td className="py-1.5">{e.label}<span className="block text-xs text-muted">{e.justification}</span></td>
            <td className="text-right tabular-nums text-muted">{d.by_kind[e.kind]?.count ?? 0}×</td>
            <td className="text-right tabular-nums">
              <button className="underline" onClick={async () => {
                const v = prompt(`Minutes for "${e.label}" (applies from now on)`, String(e.minutes));
                if (v === null || Number.isNaN(Number(v))) return;
                const why = prompt('One-line justification', e.justification) ?? e.justification;
                await api('/admin/impact/estimates', { method: 'PUT', body: { kind: e.kind, minutes: Number(v), justification: why } });
                load();
              }}>{e.minutes} min</button>
            </td>
          </tr>
        ))}
      </tbody></table>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={counter} onChange={async (ev) => { await api('/admin/settings', { method: 'PUT', body: { showImpactCounter: ev.target.checked } }); setCounter(ev.target.checked); }} />
        Show “hours given back” on the landing page
      </label>
    </Panel>
  );
}

function FeedbackList() {
  const [only, setOnly] = useState(false);
  const [rows, setRows] = useState<{ id: string; rating: number | null; text: string | null; quotable: boolean; first_name: string; account_kind: string; created_at: string }[]>([]);
  useEffect(() => { api<{ feedback: typeof rows }>(`/admin/feedback${only ? '?quotable=1' : ''}`).then((r) => setRows(r.feedback)).catch(() => {}); }, [only]);
  return (
    <Panel title="Feedback" aside={<label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} />Quotable only</label>}>
      {!rows.length ? <p className="text-sm text-muted">No feedback yet.</p> : rows.map((r) => (
        <div key={r.id} className="border-b border-line/60 py-2 text-sm last:border-0">
          <p>{r.rating ? `${r.rating}/5` : '—'} · {r.first_name}{r.account_kind !== 'user' ? ` (${r.account_kind})` : ''}{r.quotable ? ' · quotable' : ''} <span className="text-xs text-muted">{new Date(r.created_at).toLocaleDateString()}</span></p>
          {r.text && <p className="text-white/80">“{r.text}”</p>}
        </div>
      ))}
    </Panel>
  );
}

function Metrics() {
  const [m, setM] = useState<{ users: number; users_by_country: { country: string | null; count: number }[]; waitlist_by_country: { country: string | null; count: number }[] } | null>(null);
  useEffect(() => { api<typeof m>('/admin/metrics').then(setM).catch(() => {}); }, []);
  if (!m) return null;
  const table = (rows: { country: string | null; count: number }[]) => (
    <table className="w-full text-sm"><tbody>
      {rows.sort((a, b) => b.count - a.count).map((r) => <tr key={r.country ?? '?'} className="border-t border-line"><td className="py-1.5">{r.country ?? 'Unknown'}</td><td className="text-right tabular-nums">{r.count}</td></tr>)}
    </tbody></table>
  );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Panel title="Users by sign-up country" aside={<span className="text-sm">{m.users} total</span>}>{table(m.users_by_country)}</Panel>
      <Panel title="Waitlist by country">{m.waitlist_by_country.length ? table(m.waitlist_by_country) : <p className="text-sm text-muted">Nobody waiting.</p>}</Panel>
    </div>
  );
}

interface Connector { slug: string; name: string; category: string; iconUrl: string | null; tagline: string; featured: boolean; badge: string | null; live: boolean; senderDomains: string[] }

/** Service Store catalog: upload each service's icon (PNG/SVG, square, ≤ 512 KB). */
function Services() {
  const [list, setList] = useState<Connector[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => api<{ connectors: Connector[] }>('/admin/connectors').then((r) => setList(r.connectors)), []);
  useEffect(() => void load(), [load]);
  return (
    <Panel title="Services" aside={<span className="text-xs text-muted">icons: square PNG or SVG, max 512 KB</span>}>
      {note && <p className="mb-2 text-sm">{note}</p>}
      <AddMcpConnector onSaved={() => void load()} />
      <ul className="mt-3 divide-y divide-line">
        {list.map((c) => (
          <li key={c.slug} className="flex items-center gap-3 py-3 text-sm">
            {c.iconUrl ? <img src={c.iconUrl} alt="" className="h-12 w-12 rounded-xl bg-white object-contain" /> : <span className="grid h-12 w-12 place-items-center rounded-xl bg-line text-lg">{c.name[0]}</span>}
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{c.name} <span className="text-xs text-muted">{c.category}{c.featured ? ' · featured' : ''}{c.badge ? ` · ${c.badge}` : ''}{c.live ? '' : ' · hidden'}</span></span>
              <span className="block truncate text-xs text-muted">{c.tagline}{c.senderDomains.length ? ` · reads mail from ${c.senderDomains.join(', ')}` : ''}</span>
            </span>
            <label className="cursor-pointer rounded-full border border-line px-3 py-1.5 text-xs hover:border-white/40">
              {c.iconUrl ? 'Replace icon' : 'Upload icon'}
              <input type="file" accept="image/png,image/svg+xml" className="hidden" onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (f.size > 512 * 1024) return setNote('Icons can be at most 512 KB.');
                const form = new FormData();
                form.append('file', f);
                try {
                  await api(`/admin/connectors/${c.slug}/icon`, { form });
                  setNote(`${c.name}: icon updated.`);
                  void load();
                } catch (err) { setNote(err instanceof ApiError ? err.message : 'Upload failed'); }
              }} />
            </label>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

interface PartnerApp { id: string; company: string; website: string; country: string; contactName: string; email: string; category: string; intendedUse: string; requestedScopes: string[]; status: string }
interface PartnerRow { id: string; slug: string; name: string; status: string; verified: boolean; scopes: string[]; pendingManifest: unknown; credentials: { client_id: string; label: string | null; last_used_at: string | null }[]; quality: { score: number; approval_rate: number | null; dismissal_rate: number | null; reports: number; throttled: boolean } }

/** Partner API (P1/P7): review applications, credentials (secret shown once), suspend, verify, quality. */
function Partners() {
  const [d, setD] = useState<{ applications: PartnerApp[]; partners: PartnerRow[]; scopes: string[] } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const load = useCallback(() => api<typeof d>('/admin/partners').then(setD), []);
  useEffect(() => void load(), [load]);
  if (!d) return null;
  const pending = d.applications.filter((a) => a.status === 'pending');
  return (
    <div className="space-y-4">
      {secret && <p className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">New credentials — copy now, the secret is shown only once:<br /><code className="break-all">{secret}</code></p>}
      <Panel title="Applications" aside={<span className="text-xs text-muted">{pending.length} pending</span>}>
        {!pending.length && <p className="text-sm text-muted">No pending applications.</p>}
        <ul className="space-y-3">
          {pending.map((a) => (
            <li key={a.id} className="rounded-xl border border-line p-3 text-sm">
              <p className="font-medium">{a.company} <span className="text-xs text-muted">{a.country} · {a.category} · <a className="underline" href={a.website} target="_blank" rel="noreferrer">{a.website}</a></span></p>
              <p className="text-xs text-muted">{a.contactName} · {a.email}</p>
              <p className="mt-1">{a.intendedUse}</p>
              <form className="mt-2 flex flex-wrap items-center gap-3 text-xs" onSubmit={async (e) => {
                e.preventDefault();
                const scopes = new FormData(e.currentTarget).getAll('scopes');
                const r = await api<{ credentials: { client_id: string; client_secret: string } }>(`/admin/partner-applications/${a.id}/approve`, { body: { scopes } });
                setSecret(`${r.credentials.client_id} / ${r.credentials.client_secret}`);
                void load();
              }}>
                {d.scopes.map((s) => <label key={s} className="inline-flex items-center gap-1"><input type="checkbox" name="scopes" value={s} defaultChecked={a.requestedScopes.includes(s)} className="accent-white" />{s}</label>)}
                <Button className="px-3 py-1.5">Approve</Button>
                <button type="button" className="text-bad" onClick={async () => { await api(`/admin/partner-applications/${a.id}/reject`, { method: 'POST', body: {} }); void load(); }}>Reject</button>
              </form>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Partners">
        <ul className="divide-y divide-line text-sm">
          {d.partners.map((p) => (
            <li key={p.id} className="space-y-1 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{p.name} <span className="text-xs text-muted">{p.status}{p.verified ? ' · verified' : ''}</span></span>
                <span className={`text-xs ${p.quality.throttled ? 'text-bad' : 'text-muted'}`}>quality {p.quality.score}{p.quality.throttled ? ' · throttled' : ''} · approvals {p.quality.approval_rate ?? '–'} · dismissals {p.quality.dismissal_rate ?? '–'} · reports {p.quality.reports}</span>
              </div>
              <p className="text-xs text-muted">{p.scopes.join(' · ')}</p>
              <p className="text-xs text-muted">{p.credentials.map((c) => `${c.client_id}${c.label ? ` (${c.label})` : ''}`).join(', ') || 'no credentials'}</p>
              <div className="flex flex-wrap gap-3 text-xs">
                <button className="underline" onClick={async () => { await api(`/admin/partners/${p.id}`, { method: 'PATCH', body: { status: p.status === 'active' ? 'suspended' : 'active' } }); void load(); }}>{p.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
                <button className="underline" onClick={async () => { await api(`/admin/partners/${p.id}`, { method: 'PATCH', body: { verified: !p.verified } }); void load(); }}>{p.verified ? 'Unverify' : 'Mark verified'}</button>
                <button className="underline" onClick={async () => { const r = await api<{ client_id: string; client_secret: string }>(`/admin/partners/${p.id}/credentials`, { method: 'POST', body: { label: 'admin' } }); setSecret(`${r.client_id} / ${r.client_secret}`); void load(); }}>New credentials</button>
                {p.credentials.map((c) => <button key={c.client_id} className="text-bad" onClick={async () => { await api(`/admin/partner-credentials/${c.client_id}`, { method: 'DELETE' }); void load(); }}>Revoke {c.client_id.slice(0, 10)}…</button>)}
                {Boolean(p.pendingManifest) && <button className="underline" onClick={async () => { await api(`/admin/partners/${p.id}/manifest/approve`, { method: 'POST' }); void load(); }}>Approve manifest</button>}
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}


interface AdminUser { id: string; email: string; name: string; kind: string; created_at: string; pending_approval: boolean; guest: boolean; verified: boolean; phone: string | null; country: string | null; credit_usd: number; emails_24h: number; email_suspended: boolean; suspended: boolean; handle: string | null }

function Users() {
  const [q, setQ] = useState('');
  const [pending, setPending] = useState(false);
  const [list, setList] = useState<AdminUser[]>([]);
  const load = useCallback(() => api<{ users: AdminUser[] }>(`/admin/users?q=${encodeURIComponent(q)}${pending ? '&pending=1' : ''}`).then((r) => setList(r.users)), [q, pending]);
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);
  const act = async (path: string, body: object) => { try { await api(path, { body }); } catch (e) { alert(e instanceof ApiError ? e.message : 'Failed'); } void load(); };
  return (
    <Panel title="Users" aside={<span className="text-xs text-muted">{list.length} shown</span>}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by email or name…" className="mb-2 w-full rounded-full border border-line bg-ink px-4 py-2 outline-none" />
      <label className="mb-3 flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} /> Waiting for approval only (beta)</label>
      <ul className="divide-y divide-line text-sm">
        {list.map((u) => (
          <li key={u.id} className="space-y-1 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><span className="font-medium">{u.name}</span> <span className="text-muted">{u.email}{u.handle ? ` · @${u.handle}` : ''}</span></span>
              <span className="text-xs">{u.pending_approval && <span className="mr-1 rounded-full border border-rim/60 px-1.5 text-rim">waiting for approval</span>}{u.guest && <span className="mr-1 rounded-full border border-line px-1.5 text-muted">WhatsApp guest</span>}{u.kind !== 'user' && <span className="mr-1 rounded-full border border-warn/50 px-1.5 text-warn">{u.kind}</span>}{u.verified ? <span className="text-ok">verified {u.phone}</span> : <span className="text-muted">not verified</span>} · {u.country ?? '?'} · <span className="tabular-nums">${u.credit_usd.toFixed(2)}</span> · {u.emails_24h} emails/24h</span>
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              {u.pending_approval && <button className="font-medium text-ok underline" onClick={() => void act(`/admin/users/${u.id}/approve`, {})}>Approve</button>}
              <button className="underline" onClick={() => { const a = prompt(`Top up ${u.email} by how many USD? (negative to deduct)`); if (!a) return; const reason = prompt('Reason (logged)'); if (reason) void act(`/admin/users/${u.id}/topup`, { amount_usd: Number(a), reason }); }}>Top up credit</button>
              <button className={u.email_suspended ? 'text-ok' : 'text-warn'} onClick={() => void act(`/admin/users/${u.id}/suspend`, { what: 'email', suspended: !u.email_suspended })}>{u.email_suspended ? 'Restore email' : 'Suspend email'}</button>
              <button className={u.suspended ? 'text-ok' : 'text-bad'} onClick={() => { if (u.suspended || confirm(`Suspend ${u.email}? They can't log in, and their public page goes offline.`)) void act(`/admin/users/${u.id}/suspend`, { what: 'account', suspended: !u.suspended }); }}>{u.suspended ? 'Restore account' : 'Suspend account'}</button>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Daily() {
  const [days, setDays] = useState<Record<string, number | string>[]>([]);
  useEffect(() => { api<{ days: typeof days }>('/admin/metrics/daily?days=14').then((r) => setDays(r.days)).catch(() => {}); }, []);
  if (!days.length) return null;
  const cols = Object.keys(days[0]!).filter((c) => c !== 'date');
  const label = (c: string) => c.replace(/_usd$/, ' $').replace(/_/g, ' ');
  return (
    <Panel title="Daily" aside={<a href="/api/admin/metrics/daily.csv?days=30" className="text-xs underline">Download CSV (30 days)</a>}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead><tr className="text-left text-muted"><th className="py-1 pr-3">date</th>{cols.map((c) => <th key={c} className="px-2 py-1 text-right">{label(c)}</th>)}</tr></thead>
          <tbody>{[...days].reverse().map((d) => <tr key={String(d.date)} className="border-t border-line"><td className="py-1 pr-3">{d.date}</td>{cols.map((c) => <td key={c} className="px-2 text-right">{d[c]}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </Panel>
  );
}

interface LatencySummary {
  days: number;
  turns: number;
  tts_modes: Record<string, number>;
  stages: { key: string; label: string; n: number; p50: number | null; p90: number | null }[];
}

/** Voice pipeline latency per stage (p50 / p90 over the last 7 days of voice turns on Talk). */
function Latency() {
  const [s, setS] = useState<LatencySummary | null>(null);
  useEffect(() => { api<LatencySummary>('/admin/metrics/latency?days=7').then(setS).catch(() => {}); }, []);
  if (!s) return null;
  const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v} ms`);
  const modes = Object.entries(s.tts_modes).map(([k, v]) => `${v} ${k}`).join(', ');
  return (
    <Panel title="Voice latency" aside={<span className="text-xs text-muted">{s.turns} voice turns, last {s.days} days{modes ? ` · voice: ${modes}` : ''}</span>}>
      {!s.turns ? <p className="text-sm text-muted">No voice turns yet.</p> : (
        <table className="w-full text-sm tabular-nums">
          <thead><tr className="text-left text-xs text-muted"><th className="py-1">Stage</th><th className="px-2 text-right">p50</th><th className="px-2 text-right">p90</th><th className="pl-2 text-right">turns</th></tr></thead>
          <tbody>
            {s.stages.map((x) => (
              <tr key={x.key} className={`border-t border-line ${x.key === 'totalMs' ? 'font-medium' : ''}`}>
                <td className="py-1.5 pr-2">{x.label}</td><td className="px-2 text-right">{ms(x.p50)}</td><td className="px-2 text-right">{ms(x.p90)}</td><td className="pl-2 text-right text-muted">{x.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

interface Report { id: string; reason: string; reporterContact: string | null; status: string; createdAt: string; handle: string | null; display_name: string | null; ipersonId: string | null }

function Reports() {
  const [list, setList] = useState<Report[]>([]);
  const load = useCallback(() => api<{ reports: Report[] }>('/admin/reports').then((r) => setList(r.reports)), []);
  useEffect(() => void load(), [load]);
  return (
    <Panel title="Reports" aside={<span className="text-xs text-muted">{list.filter((r) => r.status === 'open').length} open</span>}>
      {!list.length && <p className="text-sm text-muted">No reports.</p>}
      <ul className="divide-y divide-line text-sm">
        {list.map((r) => (
          <li key={r.id} className={`space-y-1 py-3 ${r.status === 'closed' ? 'opacity-50' : ''}`}>
            <p><span className="font-medium">{r.handle ? <a className="underline" href={`/@${r.handle}`} target="_blank" rel="noreferrer">@{r.handle}</a> : r.display_name ?? '—'}</span> <span className="text-xs text-muted">{new Date(r.createdAt).toLocaleString()}{r.reporterContact ? ` · from ${r.reporterContact}` : ''}</span></p>
            <p>{r.reason}</p>
            {r.status === 'open' && <button className="text-xs underline" onClick={async () => { await api(`/admin/reports/${r.id}/close`, { method: 'POST' }); void load(); }}>Close</button>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

interface RuntimeSettings { freeCreditUsd: number; feeRatio: number; emailPerHour: number; emailPerDay: number; requireApproval: boolean; plusPriceUsd: number; giftPresetsUsd: number[]; showWaitlistLine: boolean; showCallsPanel: boolean }

function Settings() {
  const [s, setS] = useState<RuntimeSettings | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { api<{ settings: RuntimeSettings }>('/admin/settings').then((r) => setS(r.settings)); }, []);
  if (!s) return null;
  const field = (k: Exclude<keyof RuntimeSettings, 'requireApproval' | 'giftPresetsUsd' | 'showWaitlistLine' | 'showCallsPanel'>, label: string, step = 1) => (
    <label className="flex items-center justify-between gap-3 py-2 text-sm">
      <span>{label}</span>
      <input type="number" step={step} defaultValue={s[k] ?? ''} className="w-40 rounded-full border border-line bg-ink px-3 py-1.5 text-right"
        onBlur={async (e) => {
          const v = Number(e.target.value);
          if (v === s[k]) return;
          try { setS((await api<{ settings: RuntimeSettings }>('/admin/settings', { method: 'PUT', body: { [k]: v } })).settings); setNote('Saved — applies within 10 seconds.'); } catch { setNote('Invalid value.'); }
        }} />
    </label>
  );
  return (
    <Panel title="Settings" aside={<span className="text-xs text-muted">override .env at runtime</span>}>
      <div className="divide-y divide-line">
        {field('freeCreditUsd', 'Free AI credit for new users ($)', 0.5)}
        {field('feeRatio', 'Platform fee (× Meta cost)', 0.1)}
        {field('emailPerHour', 'Emails per user per hour')}
        {field('emailPerDay', 'Emails per user per day')}
        {field('plusPriceUsd', 'Plus plan price on /pricing ($/month, not sold yet)', 1)}
        <label className="flex items-center justify-between gap-3 py-2 text-sm">
          <span>Gift amounts ($, comma-separated)</span>
          <input defaultValue={s.giftPresetsUsd.join(', ')} className="w-40 rounded-full border border-line bg-ink px-3 py-1.5 text-right"
            onBlur={async (e) => {
              const v = e.target.value.split(',').map((x) => Number(x.trim())).filter((n) => n > 0);
              try { setS((await api<{ settings: RuntimeSettings }>('/admin/settings', { method: 'PUT', body: { giftPresetsUsd: v } })).settings); setNote('Saved — applies within 10 seconds.'); } catch { setNote('Invalid value.'); }
            }} />
        </label>
        <label className="flex items-center justify-between gap-3 py-2 text-sm">
          <span>Landing page: "People in N countries are waiting for i-persons"</span>
          <input type="checkbox" checked={s.showWaitlistLine} onChange={async (e) => { setS((await api<{ settings: RuntimeSettings }>('/admin/settings', { method: 'PUT', body: { showWaitlistLine: e.target.checked } })).settings); setNote('Saved — applies within 10 seconds.'); }} />
        </label>
        <label className="flex items-center justify-between gap-3 py-2 text-sm">
          <span>Beta: new accounts wait for approval (requests go to contact@i-persons.com)</span>
          <input type="checkbox" checked={s.requireApproval} onChange={async (e) => { setS((await api<{ settings: RuntimeSettings }>('/admin/settings', { method: 'PUT', body: { requireApproval: e.target.checked } })).settings); setNote('Saved — applies within 10 seconds.'); }} />
        </label>
        <label className="flex items-center justify-between gap-3 py-2 text-sm">
          <span>Demo accounts: show the live “Meta AI calls” panel</span>
          <input type="checkbox" checked={s.showCallsPanel} onChange={async (e) => { setS((await api<{ settings: RuntimeSettings }>('/admin/settings', { method: 'PUT', body: { showCallsPanel: e.target.checked } })).settings); setNote('Saved — applies within 10 seconds (reload the page).'); }} />
        </label>
      </div>
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
    </Panel>
  );
}

/** Phase 4b: add a remote MCP server as a Store connector (tested on save). */
export function AddMcpConnector({ onSaved }: { onSaved(): void }) {
  const [tools, setTools] = useState<string[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  return (
    <form className="mt-4 space-y-2 rounded-xl border border-line p-3 text-sm" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const allow = f.getAll('tools').map(String);
      setNote('Testing the connection…');
      try {
        const r = await api<{ tools?: string[] }>('/admin/connectors', { method: 'PUT', body: {
          slug: f.get('slug'), name: f.get('name'), type: 'mcp', category: f.get('category'), tagline: f.get('tagline'),
          mcp_url: f.get('url'), ...(f.get('auth') ? { mcp_auth: f.get('auth') } : {}), ...(tools ? { tool_allowlist: allow } : {}),
          scopes: [{ id: 'use_tools', label: `Use ${f.get('name')}`, description: `My twin may propose actions with ${f.get('name')} (I approve each one)`, required: true }],
        } });
        setTools(r.tools ?? []);
        setNote(`Connected. ${r.tools?.length ?? 0} tools found — untick any you don't want, then save again.`);
        onSaved();
      } catch (err) { setNote(err instanceof ApiError ? err.message : 'Failed'); }
    }}>
      <p className="text-xs uppercase tracking-wider text-muted">Add an MCP connector</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input name="name" required placeholder="Name" className="rounded-full border border-line bg-ink px-3 py-1.5" />
        <input name="slug" required pattern="[a-z0-9-]{2,40}" placeholder="Slug" className="rounded-full border border-line bg-ink px-3 py-1.5" />
        <input name="url" required type="url" placeholder="https://…/mcp" className="rounded-full border border-line bg-ink px-3 py-1.5 sm:col-span-2" />
        <input name="auth" placeholder="Auth header (optional, stored encrypted)" className="rounded-full border border-line bg-ink px-3 py-1.5 sm:col-span-2" />
        <input name="tagline" required placeholder="One-line tagline" className="rounded-full border border-line bg-ink px-3 py-1.5" />
        <select name="category" className="rounded-full border border-line bg-ink px-3 py-1.5">{['shopping', 'travel', 'jobs', 'productivity', 'other'].map((c) => <option key={c}>{c}</option>)}</select>
      </div>
      {tools && <div className="flex flex-wrap gap-3">{tools.map((t) => <label key={t} className="inline-flex items-center gap-1"><input type="checkbox" name="tools" value={t} defaultChecked className="accent-white" /><code className="text-xs">{t}</code></label>)}</div>}
      <Button className="w-full">{tools ? 'Save tool selection' : 'Test & save'}</Button>
      {note && <p className="text-xs text-muted">{note}</p>}
    </form>
  );
}

/** Impact §4: gift requests (mark paid → code sent) and family pools (top up once paid). No payment provider yet. */
function GiftsAdmin() {
  interface G { id: string; status: string; amount_usd: number; buyer_name: string; buyer_contact: string; recipient_name: string; recipient: string; code: string | null; created_at: string; wa_link: string | null }
  const [list, setList] = useState<G[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => api<{ gifts: G[] }>('/admin/gifts').then((r) => setList(r.gifts)), []);
  useEffect(() => void load(), [load]);
  const paid = async (g: G) => {
    if (!confirm(`Mark $${g.amount_usd} from ${g.buyer_name} as paid? This sends the gift code.`)) return;
    try { const r = await api<{ code: string; emailed: boolean }>(`/admin/gifts/${g.id}/paid`, { method: 'POST' }); setNote(`${r.code} ${r.emailed ? 'emailed to the recipient' : 'ready: send the WhatsApp link to the buyer'}.`); } catch (e) { setNote(e instanceof ApiError ? e.message : 'Failed'); }
    void load();
  };
  return (
    <Panel title="Gifts" aside={<span className="text-xs text-muted">{list.filter((g) => g.status === 'pending_payment').length} waiting for payment</span>}>
      {note && <p className="mb-2 text-xs text-ok">{note}</p>}
      {list.length === 0 ? <p className="text-sm text-muted">No gift requests yet.</p> : (
        <ul className="divide-y divide-line text-sm">
          {list.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span><span className="tabular-nums">${g.amount_usd}</span> · {g.buyer_name} <span className="text-muted">({g.buyer_contact})</span> → {g.recipient_name} <span className="text-muted">({g.recipient})</span></span>
              <span className="flex items-center gap-3 text-xs">
                <span className={g.status === 'pending_payment' ? 'text-warn' : g.status === 'cancelled' ? 'text-muted' : 'text-ok'}>{g.status.replace('_', ' ')}{g.code ? ` · ${g.code}` : ''}</span>
                {g.status === 'pending_payment' && <><button className="text-ok underline" onClick={() => void paid(g)}>Mark paid</button><button className="text-muted underline" onClick={async () => { await api(`/admin/gifts/${g.id}/cancel`, { method: 'POST' }); void load(); }}>Cancel</button></>}
                {g.status === 'paid' && g.wa_link && <a href={g.wa_link} target="_blank" rel="noreferrer" className="underline">WhatsApp text</a>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function FamiliesAdmin() {
  interface F { id: string; name: string; owner: string; members: number; pool_usd: number; created_at: string }
  const [list, setList] = useState<F[]>([]);
  const load = useCallback(() => api<{ families: F[] }>('/admin/families').then((r) => setList(r.families)), []);
  useEffect(() => void load(), [load]);
  return (
    <Panel title="Family plans" aside={<span className="text-xs text-muted">{list.length} groups</span>}>
      {list.length === 0 ? <p className="text-sm text-muted">No family plans yet.</p> : (
        <ul className="divide-y divide-line text-sm">
          {list.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{f.name} <span className="text-muted">· {f.owner} · {f.members} members</span></span>
              <span className="flex items-center gap-3 text-xs"><span className="tabular-nums">pool ${f.pool_usd.toFixed(2)}</span>
                <button className="underline" onClick={async () => { const a = prompt(`Add how many USD to ${f.name}'s pool? (negative to deduct)`); if (!a) return; const reason = prompt('Reason (logged), e.g. "paid by bank transfer"'); if (!reason) return; try { await api(`/admin/families/${f.id}/topup`, { body: { amount_usd: Number(a), reason } }); } catch (e) { alert(e instanceof ApiError ? e.message : 'Failed'); } void load(); }}>Top up pool</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Impact §9: waitlist demand by country, daily growth, and sign-ups that came through someone's share link. */
function WaitlistGrowth() {
  interface W { totals: { total: number; countries: number; from_shares: number }; by_country: { country: string | null; total: number; last_7d: number; from_shares: number }[]; daily: { day: string; n: number; from_shares: number }[] }
  const [w, setW] = useState<W | null>(null);
  useEffect(() => { api<W>('/admin/waitlist/growth?days=30').then(setW).catch(() => {}); }, []);
  if (!w) return null;
  const name = (c: string | null) => (c ? new Intl.DisplayNames(['en'], { type: 'region' }).of(c) ?? c : 'Unknown');
  const max = Math.max(1, ...w.daily.map((d) => d.n));
  return (
    <Panel title="Waitlist demand" aside={<span className="text-xs text-muted">{w.totals.total} people · {w.totals.countries} countries · {w.totals.from_shares} via share links</span>}>
      {w.by_country.length === 0 ? <p className="text-sm text-muted">Nobody on the waitlist yet.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="pb-1">Country</th><th className="pb-1 text-right">Waiting</th><th className="pb-1 text-right">Last 7 days</th><th className="pb-1 text-right">Via share links</th></tr></thead>
          <tbody>{w.by_country.map((c) => <tr key={c.country ?? '?'} className="border-t border-line"><td className="py-1">{name(c.country)}</td><td className="text-right tabular-nums">{c.total}</td><td className="text-right tabular-nums">{c.last_7d ? `+${c.last_7d}` : 0}</td><td className="text-right tabular-nums">{c.from_shares}</td></tr>)}</tbody>
        </table></div>
      )}
      {w.daily.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-xs text-muted">Daily sign-ups, last 30 days</p>
          <div className="flex h-16 items-end gap-0.5">{w.daily.map((d) => <div key={d.day} title={`${d.day}: ${d.n} (${d.from_shares} via share links)`} className="flex-1 rounded-t bg-rim/70" style={{ height: `${(d.n / max) * 100}%` }} />)}</div>
        </div>
      )}
    </Panel>
  );
}
