import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Button } from '../components/ui.tsx';
import { useSession } from '../session.tsx';
import { MailboxBanner, ConnectMailbox, Mailboxes, PasteConfirmation } from '../components/Mailbox.tsx';

// Service Store (Phase B): app-store style. Icons are uploaded by the admin; until then a monogram.

interface Scope { id: string; label: string; description: string; required?: boolean }
interface Service {
  slug: string; name: string; type: string; category: string; icon_url: string | null; cover_url: string | null;
  tagline: string; long_description: string; capabilities: string[]; scopes: Scope[];
  featured: boolean; badge: string | null; verified: boolean; operated_by_team?: boolean;
  active: boolean; granted_scopes: string[]; health: string | null; status_line: string | null;
}
const CATEGORY_LABEL: Record<string, string> = { all: 'All', shopping: 'Shopping', travel: 'Travel', jobs: 'Jobs', productivity: 'Productivity', other: 'Other' };

function Icon({ s, size = 56 }: { s: Pick<Service, 'slug' | 'name' | 'icon_url'>; size?: number }) {
  if (s.icon_url) return <img src={s.icon_url} alt="" width={size} height={size} className="rounded-2xl bg-white object-contain" style={{ width: size, height: size }} />;
  let h = 0;
  for (const c of s.slug) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span aria-hidden className="grid place-items-center rounded-2xl font-semibold text-white" style={{ width: size, height: size, fontSize: size * 0.45, background: `linear-gradient(135deg, hsl(${h} 60% 45%), hsl(${(h + 40) % 360} 60% 32%))` }}>
      {s.name[0]}
    </span>
  );
}

function Badge({ s }: { s: Service }) {
  return (
    <>
      {s.badge && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide">{s.badge}</span>}
      {s.verified && <span className="rounded-full bg-rim/20 px-2 py-0.5 text-[10px] text-rim">Verified partner</span>}
      {s.operated_by_team && <span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-muted">Operated by the i-persons team</span>}
    </>
  );
}

export function Store() {
  const { iperson } = useSession();
  const [services, setServices] = useState<Service[]>([]);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [open, setOpen] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const load = useCallback(() => api<{ services: Service[] }>('/store').then((r) => setServices(r.services)), []);
  useEffect(() => void load(), [load]);

  const shown = useMemo(() => services.filter((s) => (cat === 'all' || s.category === cat)
    && (!q || `${s.name} ${s.tagline} ${s.category}`.toLowerCase().includes(q.toLowerCase()))), [services, q, cat]);
  const active = services.filter((s) => s.active);
  const featured = shown.filter((s) => s.featured);
  const current = services.find((s) => s.slug === open);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Service Store</h1>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search services…" aria-label="Search services"
          className="w-full rounded-full border border-line bg-panel px-4 py-2.5 outline-none focus:border-rim/60" />
        <div className="flex gap-2 overflow-x-auto pb-1">
          {Object.entries(CATEGORY_LABEL).map(([id, label]) => (
            <button key={id} onClick={() => setCat(id)} className={`shrink-0 rounded-full border px-3 py-1.5 text-sm ${cat === id ? 'border-white bg-white text-black' : 'border-line text-muted hover:text-white'}`}>{label}</button>
          ))}
        </div>
      </div>

      {toast && (
        <div role="status" className="flex items-center gap-3 rounded-2xl border border-ok/40 bg-ok/10 p-3 text-sm">
          {iperson?.avatarUrl && <img src={iperson.avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover" />}
          <span>👍 {toast}</span>
        </div>
      )}

      <MailboxBanner />
      <Mailboxes />

      {active.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs uppercase tracking-wider text-muted">My active services</h2>
          <ul className="space-y-2">
            {active.map((s) => (
              <li key={s.slug}>
                <button onClick={() => setOpen(s.slug)} className="flex w-full items-center gap-3 rounded-2xl border border-line bg-panel p-3 text-left hover:border-white/30">
                  <Icon s={s} size={40} />
                  <span className="min-w-0 flex-1"><span className="block font-medium">{s.name}</span><span className="block truncate text-xs text-muted">{s.status_line ?? s.tagline}</span></span>
                  {s.health === 'needs_attention' ? <span className="flex items-center gap-1.5 text-xs text-warn"><span className="h-2 w-2 rounded-full bg-warn" />Needs attention</span> : <span className="text-xs text-ok">Active</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {featured.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs uppercase tracking-wider text-muted">Featured</h2>
          <div className="flex snap-x gap-3 overflow-x-auto pb-2">
            {featured.map((s) => (
              <button key={s.slug} onClick={() => setOpen(s.slug)} className="relative h-40 w-72 shrink-0 snap-start overflow-hidden rounded-3xl border border-line text-left">
                {s.cover_url ? <img src={s.cover_url} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <span className="absolute inset-0 bg-gradient-to-br from-rim/30 to-panel" />}
                <span className="absolute inset-x-0 bottom-0 flex items-end gap-3 bg-gradient-to-t from-black/80 p-4">
                  <Icon s={s} size={44} />
                  <span className="min-w-0"><span className="flex items-center gap-2 font-medium">{s.name} <Badge s={s} /></span><span className="block truncate text-xs text-white/70">{s.tagline}</span></span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wider text-muted">{CATEGORY_LABEL[cat]}</h2>
        {shown.length ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {shown.map((s) => (
              <button key={s.slug} onClick={() => setOpen(s.slug)} className="flex flex-col items-center gap-1.5 rounded-2xl p-2 text-center hover:bg-panel">
                <span className="relative">
                  <Icon s={s} />
                  {s.active && s.health !== 'needs_attention' && <span aria-label="Active" className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full border-2 border-ink bg-ok text-[10px] text-black">✓</span>}
                  {s.health === 'needs_attention' && <span aria-label="Needs attention" className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-ink bg-warn" />}
                </span>
                <span className="w-full truncate text-sm">{s.name}</span>
                <span className="line-clamp-2 text-[11px] leading-tight text-muted">{s.active ? 'Active' : s.tagline}</span>
              </button>
            ))}
          </div>
        ) : <p className="text-sm text-muted">No services match.</p>}
      </section>

      {current && <Details s={current} onClose={() => setOpen(null)} onChange={async (line) => { await load(); if (line) { setToast(line); setTimeout(() => setToast(null), 6000); } }} />}
    </div>
  );
}

function Details({ s, onClose, onChange }: { s: Service; onClose(): void; onChange(line?: string): Promise<void> }) {
  const [scopes, setScopes] = useState<string[]>(s.active ? s.granted_scopes : s.scopes.map((x) => x.id));
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ next_step: { text: string }; line: string }>(`/store/${s.slug}/activate`, { body: { scopes } });
      setNext(r.next_step.text);
      await onChange(r.line);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 md:items-stretch md:justify-end" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={s.name} onClick={(e) => e.stopPropagation()}
        className="sheet-in max-h-[88vh] w-full overflow-y-auto rounded-t-3xl border border-line bg-ink p-5 md:max-h-none md:w-[26rem] md:rounded-none md:rounded-l-3xl">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line md:hidden" />
        {s.cover_url && <img src={s.cover_url} alt="" className="mb-4 h-32 w-full rounded-2xl object-cover" />}
        <div className="flex items-center gap-3">
          <Icon s={s} size={64} />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">{s.name}</h2>
            <div className="mt-1 flex flex-wrap gap-1.5"><Badge s={s} />{s.active && <span className="rounded-full bg-ok/20 px-2 py-0.5 text-[10px] text-ok">Active</span>}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="ml-auto self-start text-muted hover:text-white">✕</button>
        </div>
        <p className="mt-4 text-sm text-white/80">{s.long_description || s.tagline}</p>
        {s.operated_by_team && (
          <p className="mt-3 rounded-xl border border-line p-3 text-xs text-muted">
            {s.name} is operated by Yousoft-IT, the company that runs i-persons. It is a partner like any other: it uses only the public Partner API, with the same rules and limits, and has no private access to your data.
          </p>
        )}

        <h3 className="mt-5 text-xs uppercase tracking-wider text-muted">What your twin can do with it</h3>
        <ul className="mt-2 space-y-1 text-sm">{s.capabilities.map((c) => <li key={c}>✓ {c}</li>)}</ul>

        <h3 className="mt-5 text-xs uppercase tracking-wider text-muted">What it can access</h3>
        <ul className="mt-2 space-y-2">
          {s.scopes.map((sc) => (
            <li key={sc.id}>
              <label className="flex gap-3 rounded-xl border border-line p-3 text-sm">
                <input type="checkbox" className="mt-0.5 accent-white" disabled={sc.required || s.active} checked={sc.required || scopes.includes(sc.id)}
                  onChange={(e) => setScopes((x) => (e.target.checked ? [...x, sc.id] : x.filter((y) => y !== sc.id)))} />
                <span><span className="block font-medium">{sc.label}{sc.required ? <span className="text-xs text-muted"> · needed</span> : null}</span><span className="text-muted">{sc.description}</span></span>
              </label>
            </li>
          ))}
        </ul>

        {next && <p className="mt-4 rounded-xl border border-rim/40 bg-rim/10 p-3 text-sm">Next: {next}</p>}
        {s.type === 'mail' && (s.active || next) && <div className="mt-4 space-y-3"><ConnectMailbox services={s.name} /><PasteConfirmation slug={s.slug} name={s.name} /></div>}
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}

        <div className="mt-5">
          {!s.active ? <Button className="w-full py-3" disabled={busy} onClick={activate}>{busy ? '…' : 'Activate'}</Button>
            : !confirming ? <Button variant="danger" className="w-full" onClick={() => setConfirming(true)}>Deactivate</Button>
            : (
              <div className="space-y-2 rounded-xl border border-bad/40 p-3 text-sm">
                <p>Deactivate {s.name}? This deletes your activation and the permissions you granted{s.type === 'mail' ? ', and everything your twin learned from these emails' : ''}.</p>
                <div className="flex gap-2">
                  <Button variant="ghost" className="flex-1" onClick={() => setConfirming(false)}>Keep it</Button>
                  <Button variant="danger" className="flex-1" disabled={busy} onClick={async () => {
                    setBusy(true);
                    await api(`/store/${s.slug}/deactivate`, { method: 'POST' }).catch(() => {});
                    await onChange();
                    setBusy(false);
                    onClose();
                  }}>Deactivate</Button>
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}


