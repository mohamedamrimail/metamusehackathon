import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { Button, Field, Panel } from '../components/ui.tsx';
import { useSession } from '../session.tsx';

// Impact §4: /pricing, /gift, /redeem, /family and /family/join/<token>. No payment provider yet:
// gifts and family pools are paid by arrangement with the team, then fulfilled from admin.

/** Kept across sign-up (and the Google/Microsoft redirect); session.tsx redeems/joins once signed in. */
export const GIFT_KEY = 'ip_gift';
export const FAMILY_KEY = 'ip_family';

interface PricingInfo { free_usd: number; plus_price_usd: number; gift_presets_usd: number[]; family_max_members: number; payment_available: boolean }
const usePricing = () => {
  const [p, setP] = useState<PricingInfo | null>(null);
  useEffect(() => { api<PricingInfo>('/pricing/info').then(setP).catch(() => {}); }, []);
  return p;
};
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } };

function Page({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <div className="rim-glow flex min-h-full flex-col">
      <header className="flex items-center justify-between px-6 py-5">
        <Link to="/" className="font-semibold tracking-tight">i-persons</Link>
        <Link to="/pricing" className="text-sm text-muted hover:text-white">Pricing</Link>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-16 sm:px-6">
        <h1 className="mt-4 text-center text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        {lead && <p className="mx-auto mt-3 max-w-xl text-center text-muted">{lead}</p>}
        <div className="mt-10">{children}</div>
      </main>
    </div>
  );
}

function Card({ name, price, children, action }: { name: string; price: string; children: ReactNode; action: ReactNode }) {
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-panel/60 p-5">
      <div className="font-medium">{name}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{price}</div>
      <div className="mt-3 flex-1 space-y-1.5 text-sm text-muted">{children}</div>
      <div className="mt-5">{action}</div>
    </div>
  );
}

export function Pricing() {
  const p = usePricing();
  const { user } = useSession();
  const [plus, setPlus] = useState<'idle' | 'ask' | 'done'>('idle');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const plusInterest = async (e?: FormEvent) => {
    e?.preventDefault();
    try { await api('/pricing/plus-interest', { body: user ? {} : { email } }); setPlus('done'); } catch (err) { setNote(errorText(err)); }
  };
  if (!p) return <Page title="Pricing"><p className="text-center text-muted">Loading…</p></Page>;
  return (
    <Page title="Pricing" lead="Pay only for what your twin uses. Every AI call is charged at Meta's list price plus a small fee, from your credit.">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card name="Free" price={`$${p.free_usd}`} action={<Link to={user ? '/talk' : '/signup'} className="block rounded-full bg-white px-4 py-2 text-center text-sm font-medium text-black">{user ? 'Open my i-person' : 'Start free'}</Link>}>
          <p>${p.free_usd} of AI credit to start.</p><p>Voice, WhatsApp, approvals and your living avatar.</p>
        </Card>
        <Card name="Plus" price={`$${p.plus_price_usd}/mo`} action={
          plus === 'done' ? <p className="text-center text-sm text-ok">Thanks! We'll tell you when Plus opens.</p>
            : plus === 'ask' && !user ? (
              <form onSubmit={plusInterest} className="flex gap-2">
                <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Your email" className="min-w-0 flex-1 rounded-full border border-line bg-ink px-3 py-2 text-sm outline-none" />
                <Button type="submit">Notify me</Button>
              </form>
            ) : <Button variant="ghost" className="w-full" onClick={() => (user ? void plusInterest() : setPlus('ask'))}>Notify me</Button>
        }>
          <p className="text-warn">Coming soon.</p><p>A monthly AI credit bundle for people who talk to their twin every day.</p>
        </Card>
        <Card name="Family" price="Shared pool" action={<Link to="/family" className="block rounded-full border border-line px-4 py-2 text-center text-sm hover:border-white">Request Family plan</Link>}>
          <p>One person pays for a shared credit pool for up to {p.family_max_members} members, like a grandchild paying for grandparents.</p>
          <p>The payer sees only each member's spend and remaining credit, never their conversations.</p>
        </Card>
        <Card name="Gift a twin" price={`from $${Math.min(...p.gift_presets_usd)}`} action={<Link to="/gift" className="block rounded-full border border-line px-4 py-2 text-center text-sm hover:border-white">Give a twin</Link>}>
          <p>Buy AI credit for someone else. They get a code by email or from your own WhatsApp.</p>
        </Card>
      </div>
      {note && <p className="mt-3 text-center text-sm text-bad">{note}</p>}
      <div className="mt-10 rounded-2xl border border-line bg-panel/40 p-6 text-center">
        <div className="text-lg font-medium">For businesses: partners pay only when a person says yes</div>
        <p className="mx-auto mt-2 max-w-2xl text-sm text-muted">Your service talks to people's twins through the Partner API. You're billed for approved requests, never for impressions or clicks.</p>
        {/* HACKATHON: /partners (§6) isn't built yet; the developer page explains the Partner API meanwhile. */}
        <Link to="/developers" className="mt-4 inline-block text-sm underline">Become a partner</Link>
      </div>
    </Page>
  );
}

export function Gift() {
  const p = usePricing();
  const { user } = useSession();
  const [amount, setAmount] = useState<number | null>(null);
  const [via, setVia] = useState<'whatsapp' | 'email'>('whatsapp');
  const [done, setDone] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!p) return <Page title="Gift a twin"><p className="text-center text-muted">Loading…</p></Page>;
  const chosen = amount ?? p.gift_presets_usd[0]!;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setNote(null);
    try {
      const r = await api<{ message: string }>('/gifts', { body: {
        recipient_name: f.get('recipient_name'), [via === 'email' ? 'recipient_email' : 'recipient_phone']: f.get('recipient'),
        amount_usd: chosen, message: f.get('message') || undefined, buyer_name: f.get('buyer_name'), buyer_contact: f.get('buyer_contact'),
        country: user?.country ?? undefined,
      } });
      setDone(r.message);
    } catch (err) { setNote(errorText(err)); } finally { setBusy(false); }
  };
  return (
    <Page title="Gift a twin" lead="Give someone their own i-person: AI credit for a digital twin that acts for them, never without their yes.">
      {done ? (
        <div className="mx-auto max-w-md rounded-2xl border border-line bg-panel/60 p-6 text-center">
          <p className="text-lg font-medium">Request received</p>
          <p className="mt-2 text-muted">{done}</p>
          <Link to="/pricing" className="mt-4 inline-block text-sm underline">Back to pricing</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="mx-auto max-w-md space-y-4">
          <div>
            <p className="mb-2 text-xs uppercase tracking-wider text-muted">Amount</p>
            <div className="flex gap-2">
              {p.gift_presets_usd.map((a) => (
                <button type="button" key={a} onClick={() => setAmount(a)} className={`flex-1 rounded-full border px-3 py-2 tabular-nums ${a === chosen ? 'border-white bg-white text-black' : 'border-line'}`}>${a}</button>
              ))}
            </div>
          </div>
          <Field label="Their first name" name="recipient_name" required maxLength={60} />
          <div>
            <div className="mb-2 flex gap-3 text-sm">
              {(['whatsapp', 'email'] as const).map((v) => (
                <label key={v} className="flex items-center gap-1.5"><input type="radio" checked={via === v} onChange={() => setVia(v)} /> {v === 'whatsapp' ? 'WhatsApp' : 'Email'}</label>
              ))}
            </div>
            <Field key={via} label={via === 'whatsapp' ? 'Their WhatsApp number (with country code)' : 'Their email'} name="recipient" type={via === 'email' ? 'email' : 'tel'} required placeholder={via === 'whatsapp' ? '+216 …' : ''} />
          </div>
          <label className="block text-sm">
            <span className="mb-1.5 block text-xs uppercase tracking-wider text-muted">A personal message (optional)</span>
            <textarea name="message" maxLength={300} rows={3} className="w-full rounded-2xl border border-line bg-ink px-4 py-2.5 outline-none focus:border-white/50" />
          </label>
          <Field label="Your name" name="buyer_name" required maxLength={80} defaultValue={user?.name ?? ''} />
          <Field label="Your email or WhatsApp number" name="buyer_contact" required maxLength={120} defaultValue={user?.email ?? ''} />
          {!p.payment_available && <p className="text-sm text-muted">Online payment isn't open yet: we'll contact you to complete the payment, then send your gift.</p>}
          {note && <p className="text-sm text-bad">{note}</p>}
          <Button type="submit" disabled={busy} className="w-full">{busy ? 'Sending…' : `Gift $${chosen}`}</Button>
        </form>
      )}
    </Page>
  );
}

/** /redeem?code=GIFT-… : signed in → redeem now; otherwise keep the code and sign up first. */
export function Redeem() {
  const { user, refresh } = useSession();
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code') ?? '');
  const [result, setResult] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const redeem = async (e?: FormEvent) => {
    e?.preventDefault();
    try {
      const r = await api<{ amount_usd: number; from: string }>('/gifts/redeem', { body: { code } });
      setResult(`$${r.amount_usd} from ${r.from} is now on your account.`);
      await refresh();
    } catch (err) { setNote(errorText(err)); }
  };
  return (
    <Page title="Redeem your gift" lead="Someone gave you your own i-person.">
      <div className="mx-auto max-w-md space-y-4 text-center">
        {result ? (
          <><p className="text-lg text-ok">{result}</p><Link to="/onboarding" className="inline-block rounded-full bg-white px-6 py-2.5 font-medium text-black">Create my i-person</Link></>
        ) : user ? (
          <form onSubmit={redeem} className="space-y-3">
            <Field label="Gift code" value={code} onChange={(e) => setCode(e.target.value)} required />
            {note && <p className="text-sm text-bad">{note}</p>}
            <Button type="submit" className="w-full">Redeem</Button>
          </form>
        ) : (
          <>
            <p className="text-muted">Create your account first; your gift code {code && <span className="font-mono text-white">{code}</span>} is added right after.</p>
            <Link to="/signup" onClick={() => code && remember(GIFT_KEY, code)} className="inline-block rounded-full bg-white px-6 py-2.5 font-medium text-black">Create my account</Link>
            <p className="text-sm text-muted">Already have one? <Link to="/login" onClick={() => code && remember(GIFT_KEY, code)} className="underline">Sign in</Link></p>
          </>
        )}
      </div>
    </Page>
  );
}

interface FamilyOwner { role: 'owner'; id: string; name: string; pool_usd: number; max_members: number; members: { id: string; name: string; spent_usd: number; credit_usd: number; joined_at: string }[]; invites: { token: string; label: string | null; link: string; expires_at: string }[] }
interface FamilyMember { role: 'member'; name: string; owner: string; pool_usd: number }

/** /family: request a plan, invite members and see their spend (owner), or see the plan and leave (member). */
export function Family() {
  const { user } = useSession();
  const [f, setF] = useState<FamilyOwner | FamilyMember | null | undefined>(undefined);
  const [invite, setInvite] = useState<{ link: string; wa_link: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => api<{ family: FamilyOwner | FamilyMember | null }>('/me/family').then((r) => setF(r.family)).catch(() => setF(null)), []);
  useEffect(() => { if (user) void load(); }, [user, load]);
  const act = async (fn: () => Promise<unknown>) => { setNote(null); try { await fn(); await load(); } catch (e) { setNote(errorText(e)); } };

  if (!user) {
    return (
      <Page title="Family plan" lead="One person pays for a shared credit pool; everyone gets their own private twin.">
        <p className="text-center"><Link to="/signup" className="inline-block rounded-full bg-white px-6 py-2.5 font-medium text-black">Create my account</Link></p>
        <p className="mt-3 text-center text-sm text-muted">Already have one? <Link to="/login" className="underline">Sign in</Link></p>
      </Page>
    );
  }
  if (f === undefined) return <Page title="Family plan"><p className="text-center text-muted">Loading…</p></Page>;
  return (
    <Page title="Family plan" lead="One person pays for a shared credit pool; everyone gets their own private twin.">
      <div className="mx-auto max-w-xl space-y-4">
        {f === null && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const name = new FormData(e.currentTarget).get('name'); void act(() => api('/me/family', { body: { name } })); }}>
            <Field label="Family name" name="name" required maxLength={60} placeholder="e.g. The Trabelsis" />
            <p className="text-sm text-muted">We'll contact you to arrange the payment and fund your pool. Members use the pool first, then their own credit. You'll see only each member's spend and remaining credit, never their conversations, memory, contacts or activity.</p>
            <Button type="submit" className="w-full">Request Family plan</Button>
          </form>
        )}
        {f?.role === 'member' && (
          <Panel title={f.name}>
            <p className="text-sm">Paid by {f.owner}. Shared pool: <span className="tabular-nums">${f.pool_usd.toFixed(2)}</span>, used before your own credit.</p>
            <p className="mt-2 text-sm text-muted">{f.owner} sees only how much you've spent and your remaining credit, nothing from your twin.</p>
            <Button variant="ghost" className="mt-4" onClick={() => void act(() => api('/me/family/leave', { method: 'POST' }))}>Leave this family plan</Button>
          </Panel>
        )}
        {f?.role === 'owner' && (
          <>
            <Panel title={f.name} aside={<span className="text-sm tabular-nums">Pool ${f.pool_usd.toFixed(2)}</span>}>
              {f.pool_usd <= 0 && <p className="mb-3 text-sm text-warn">The pool is empty: we'll contact you to fund it.</p>}
              {f.members.length === 0 ? <p className="text-sm text-muted">No members yet. Invite up to {f.max_members}.</p> : (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted"><tr><th className="pb-1">Member</th><th className="pb-1 text-right">Spent</th><th className="pb-1 text-right">Own credit</th></tr></thead>
                  <tbody>{f.members.map((m) => <tr key={m.id} className="border-t border-line"><td className="py-1.5">{m.name}</td><td className="text-right tabular-nums">${m.spent_usd.toFixed(2)}</td><td className="text-right tabular-nums">${m.credit_usd.toFixed(2)}</td></tr>)}</tbody>
                </table>
              )}
            </Panel>
            <Panel title="Invite a member" aside={<span className="text-xs text-muted">{f.members.length}/{f.max_members}</span>}>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const label = new FormData(e.currentTarget).get('label'); void act(async () => setInvite(await api('/me/family/invites', { body: { label } }))); }}>
                <input name="label" maxLength={60} placeholder="Who is it for? (only you see this)" className="min-w-0 flex-1 rounded-full border border-line bg-ink px-3 py-2 text-sm outline-none" />
                <Button type="submit" disabled={f.members.length >= f.max_members}>Create link</Button>
              </form>
              {invite && (
                <div className="mt-3 space-y-2 text-sm">
                  <p className="break-all font-mono text-xs">{invite.link}</p>
                  <a href={invite.wa_link} target="_blank" rel="noreferrer" className="inline-block rounded-full bg-[#25D366] px-4 py-2 text-black">Send from my WhatsApp</a>
                </div>
              )}
              {f.invites.length > 0 && <ul className="mt-3 space-y-1 text-xs text-muted">{f.invites.map((i) => <li key={i.token}>Open link{i.label ? ` for ${i.label}` : ''}, valid until {new Date(i.expires_at).toLocaleDateString()}</li>)}</ul>}
            </Panel>
          </>
        )}
        {note && <p className="text-center text-sm text-bad">{note}</p>}
      </div>
    </Page>
  );
}

/** /family/join/<token>: who invited you, then join (signing up first if needed). */
export function FamilyJoin() {
  const { token = '' } = useParams();
  const { user } = useSession();
  const [info, setInfo] = useState<{ family: string; owner: string; valid: boolean } | null | 'missing'>(null);
  const [joined, setJoined] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { api<{ family: string; owner: string; valid: boolean }>(`/family-invites/${encodeURIComponent(token)}`).then(setInfo).catch(() => setInfo('missing')); }, [token]);
  if (info === null) return <Page title="Family plan"><p className="text-center text-muted">Loading…</p></Page>;
  if (info === 'missing' || !info.valid) return <Page title="Family plan" lead="This invite isn't valid any more. Ask for a new link." >{null}</Page>;
  return (
    <Page title={`Join the ${info.family} family plan`} lead={`${info.owner} pays for a shared AI credit pool. Your twin stays private: ${info.owner} sees only your spend and remaining credit.`}>
      <div className="mx-auto max-w-md space-y-3 text-center">
        {joined ? <><p className="text-ok">You're in!</p><Link to="/onboarding" className="inline-block rounded-full bg-white px-6 py-2.5 font-medium text-black">Continue</Link></>
          : user ? <Button onClick={async () => { try { await api(`/family-invites/${encodeURIComponent(token)}/accept`, { method: 'POST' }); setJoined(true); } catch (e) { setNote(errorText(e)); } }}>Join</Button>
          : <>
            <Link to="/signup" onClick={() => remember(FAMILY_KEY, token)} className="inline-block rounded-full bg-white px-6 py-2.5 font-medium text-black">Create my account</Link>
            <p className="text-sm text-muted">Already have one? <Link to="/login" onClick={() => remember(FAMILY_KEY, token)} className="underline">Sign in</Link></p>
          </>}
        {note && <p className="text-sm text-bad">{note}</p>}
      </div>
    </Page>
  );
}
