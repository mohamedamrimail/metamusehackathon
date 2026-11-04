import {
  AGE_RANGES, CONSENT_TEXT, DEMO_PROVIDER_CATEGORIES, isDemoAccount, CONSENT_VERSION, COUNTRIES, DISCOVERABILITY_TEXT, CURRENCIES, currencyFor, GENDERS, INTEREST_QUESTIONS, LANGUAGES,
  PROVIDER_CATEGORIES, RULE_SOURCE_LABELS, RULE_SUGGESTIONS, type AgeRange, type Gender, type LinkKind, type RuleSource,
} from '@ipersons/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';
import { Avatar } from '../avatar/Avatar.tsx';
import { Speaker } from '../audio/speaker.ts';
import { useSession } from '../session.tsx';
import { DemoNote, MailboxBanner, Mailboxes } from './Mailbox.tsx';
import { Button, Chip } from './ui.tsx';

// The first-run setup ("warm-up") screens. Rules, sources and links are also edited later on My twin.

const chip = (on: boolean) => `rounded-full border px-3.5 py-2 text-sm transition ${on ? 'border-white bg-white text-black' : 'border-line bg-panel hover:border-white/40'}`;

export function StepHeader({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div className="space-y-2">
      <h1 className="text-3xl font-semibold">{title}</h1>
      {sub && <p className="text-muted">{sub}</p>}
    </div>
  );
}

/** Continue / Later footer: optional steps can be skipped and done later on My twin. */
export function StepNav({ onNext, onLater, busy, disabled, label = 'Continue' }: { onNext(): void; onLater?(): void; busy?: boolean; disabled?: boolean; label?: string }) {
  return (
    <div className="flex gap-3 pt-2">
      {onLater && <Button variant="ghost" onClick={onLater}>Later</Button>}
      <Button className="flex-1 py-3" disabled={busy || disabled} onClick={onNext}>{busy ? '…' : label}</Button>
    </div>
  );
}

export function Gift({ onNext }: { onNext(): void }) {
  const { user } = useSession();
  return (
    <div className="space-y-6 text-center">
      <div className="mx-auto grid h-24 w-24 place-items-center rounded-full border border-rim/40 bg-rim/10 text-4xl">🎁</div>
      <StepHeader title={`$${(user?.ai_credit_usd ?? 5).toFixed(2)} on us`} sub="Your number is verified. Here’s free AI credit to start: it pays for your twin’s thinking, voice and avatar. You’ll see every cost on My twin and can top up later." />
      <StepNav onNext={onNext} label="Nice, let’s set up my twin" />
    </div>
  );
}

export function AboutYou({ onNext }: { onNext(): void }) {
  const { user, refresh } = useSession();
  const [gender, setGender] = useState<Gender | null>((user?.gender as Gender | null) ?? null);
  const [age, setAge] = useState<AgeRange | null>((user?.age_range as AgeRange | null) ?? null);
  const [lang, setLang] = useState(user?.locale ?? (navigator.language.slice(0, 2) || 'en'));
  const [country, setCountry] = useState(user?.country ?? '');
  const [currency, setCurrency] = useState(user?.currency ?? currencyFor(user?.country));
  const [agreed, setAgreed] = useState(!user?.consent_required);
  const [busy, setBusy] = useState(false);
  const pick = (c: string) => { setCountry(c); setCurrency(currencyFor(c)); };
  const sel = 'w-full rounded-xl border border-line bg-panel px-4 py-3 outline-none focus:border-rim/60';

  return (
    <div className="space-y-6">
      <StepHeader title="About you" sub="Gender and age only shape your avatar and voice: they are never shown publicly or given to your twin." />
      <Group label="Gender">
        <div className="grid grid-cols-3 gap-2">{GENDERS.map((g) => <button key={g.id} type="button" onClick={() => setGender(g.id)} className={chip(gender === g.id)}>{g.label}</button>)}</div>
      </Group>
      <Group label="Age">
        <div className="grid grid-cols-3 gap-2">{AGE_RANGES.map((a) => <button key={a} type="button" onClick={() => setAge(a)} className={chip(age === a)}>{a}</button>)}</div>
        <p className="mt-2 text-xs text-muted">i-persons is for adults only.</p>
      </Group>
      <Group label="Language">
        <div className="flex flex-wrap gap-2">{LANGUAGES.map((l) => <button key={l.id} type="button" onClick={() => setLang(l.id)} className={chip(lang === l.id)}>{l.label}</button>)}</div>
      </Group>
      <div className="grid grid-cols-2 gap-3">
        <Group label="Country">
          <select value={country} onChange={(e) => pick(e.target.value)} className={sel}>
            <option value="">Choose…</option>
            {COUNTRIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            {country && !COUNTRIES.some((c) => c.id === country) && <option value={country}>{country}</option>}
          </select>
        </Group>
        <Group label="Currency">
          <select value={currency} onChange={(e) => setCurrency(e.target.value as typeof currency)} className={sel}>
            {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Group>
      </div>
      {user?.consent_required && (
        <label className="flex gap-3 rounded-xl border border-line bg-panel p-4 text-sm">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-white" />
          <span>{CONSENT_TEXT} <a href="/terms.html" target="_blank" className="underline">Terms</a> · <a href="/privacy.html" target="_blank" className="underline">Privacy</a></span>
        </label>
      )}
      {user?.consent_required && <p className="px-1 text-xs text-muted">{DISCOVERABILITY_TEXT} (My twin → Privacy)</p>}
      <StepNav busy={busy} disabled={!gender || !age || !country || !agreed} onNext={async () => {
        setBusy(true);
        await api('/me/profile', { method: 'PATCH', body: {
          gender, age_range: age, locale: lang, country, currency, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(user?.consent_required ? { consent_version: CONSENT_VERSION } : {}),
        } });
        await refresh();
        onNext();
      }} />
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs uppercase tracking-wider text-muted">{label}</legend>
      {children}
    </fieldset>
  );
}

export function TwinName({ onNext }: { onNext(): void }) {
  const { user, iperson, refresh } = useSession();
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState(iperson?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ names: string[] }>('/me/twin-names').then((r) => { setNames(r.names); setName((n) => n || r.names[0] || ''); }).catch(() => {});
  }, []);
  return (
    <div className="space-y-6">
      <StepHeader title="Name your i-person" sub="Your twin’s name: it introduces itself with it, and people meet it at i-persons.com/@…" />
      <div className="flex flex-wrap gap-2">{names.map((n) => <button key={n} type="button" onClick={() => setName(n)} className={chip(name === n)}>{n}</button>)}</div>
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Or type a name"
        className="w-full rounded-xl border border-line bg-panel px-4 py-3 text-lg outline-none focus:border-rim/60" />
      <StepNav busy={busy} disabled={!name.trim()} onNext={async () => {
        setBusy(true);
        const body = { display_name: name.trim(), locale: user?.locale ?? 'en', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
        if (iperson) await api(`/ipersons/${iperson.id}`, { method: 'PATCH', body });
        else await api('/ipersons', { body });
        await refresh();
        onNext();
      }} />
    </div>
  );
}

// --- Know more about you: links + email ---

interface Link { id: string; kind: LinkKind; url: string; status: 'pending' | 'read' | 'private' | 'failed'; summary: string | null }
const LINK_FIELDS: { kind: LinkKind; label: string }[] = [
  { kind: 'website', label: 'Website or blog' },
  { kind: 'portfolio', label: 'Portfolio' },
  { kind: 'other', label: 'Other page of mine' },
];
const LINK_STATUS: Record<Link['status'], [string, 'muted' | 'ok' | 'warn' | 'bad']> = {
  pending: ['Reading…', 'muted'], read: ['Learned', 'ok'], private: ['Nothing public', 'warn'], failed: ['Couldn’t read', 'bad'],
};

export function LinksEditor() {
  const { iperson } = useSession();
  const [links, setLinks] = useState<Link[]>([]);
  const [kind, setKind] = useState<LinkKind>('website');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = () => api<{ links: Link[] }>(`/ipersons/${iperson!.id}/links`).then((r) => setLinks(r.links)).catch(() => {});
  useEffect(() => { void load(); }, []);
  // Poll while something is still being read.
  useEffect(() => {
    if (!links.some((l) => l.status === 'pending')) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [links]);
  const field = LINK_FIELDS.find((f) => f.kind === kind)!;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">{LINK_FIELDS.map((f) => <button key={f.kind} type="button" onClick={() => setKind(f.kind)} className={chip(kind === f.kind)}>{f.label}</button>)}</div>
      <form className="flex gap-2" onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api(`/ipersons/${iperson!.id}/links`, { body: { kind, url: /^https?:\/\//.test(url) ? url : `https://${url}` } });
          setUrl('');
          await load();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Couldn’t add it.');
        }
      }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`Paste your ${field.label} link`}
          className="min-w-0 flex-1 rounded-full border border-line bg-panel px-4 py-2.5 text-sm outline-none focus:border-rim/60" />
        <Button disabled={!url.trim()}>Add</Button>
      </form>
      {error && <p className="text-sm text-bad">{error}</p>}
      {links.map((l) => (
        <div key={l.id} className="flex items-start justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="truncate">{l.url}</p>
            {l.summary && <p className="mt-0.5 text-xs text-muted">{l.summary}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Chip tone={LINK_STATUS[l.status][1]}>{LINK_STATUS[l.status][0]}</Chip>
            <button className="text-xs text-muted hover:text-white" onClick={async () => { await api(`/ipersons/${iperson!.id}/links/${l.id}`, { method: 'DELETE' }); await load(); }}>Remove</button>
          </div>
        </div>
      ))}
      <p className="text-xs text-muted">One public page of a site you own is read (never social networks), and only if the site allows it. What your twin learns waits for your OK, then shows up under What it knows, where you can edit or delete it.</p>
      <LinkedInImport />
    </div>
  );
}

/** LinkedIn without scraping: the user pastes their About + experience, or uploads LinkedIn's own PDF. */
export function LinkedInImport() {
  const { iperson } = useSession();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const send = async (init: { body?: unknown; form?: FormData }) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api<{ learned: number; summary: string }>(`/ipersons/${iperson!.id}/linkedin`, init);
      setNote(`Learned ${r.learned} thing${r.learned === 1 ? '' : 's'}: ${r.summary}`);
      setText('');
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Couldn’t read that.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-xl border border-line bg-panel p-3 text-sm">
      <p className="font-medium">LinkedIn</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Paste your LinkedIn “About” and experience"
        className="w-full rounded-xl border border-line bg-ink px-3 py-2 outline-none focus:border-rim/60" />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || text.trim().length < 40} onClick={() => void send({ body: { text } })}>{busy ? 'Reading…' : 'Learn from this'}</Button>
        <label className="cursor-pointer rounded-full border border-line px-4 py-2 text-sm text-muted hover:text-white">
          Upload LinkedIn PDF
          <input type="file" accept="application/pdf" className="hidden" disabled={busy} onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const form = new FormData();
            form.append('file', f);
            void send({ form });
            e.target.value = '';
          }} />
        </label>
      </div>
      <p className="text-xs text-muted">On LinkedIn: your profile → More → Save to PDF. We never open LinkedIn ourselves.</p>
      {note && <p className="text-xs">{note}</p>}
    </div>
  );
}

const MAIL_SERVICES = ['amazon-de', 'booking', 'skyscanner'];

export function KnowMore({ onNext, onLater }: { onNext(): void; onLater(): void }) {
  const [mailOpen, setMailOpen] = useState(false);
  const [mailError, setMailError] = useState<string | null>(null);
  const [mail, setMail] = useState<{ providers: { microsoft: boolean; google: boolean }; mailboxes: unknown[]; demo: { allowed: boolean; mailboxes: string[] } | null } | null>(null);
  useEffect(() => { api<typeof mail>('/connections/mail').then(setMail).catch(() => {}); }, []);
  const providers = mail ? (['microsoft', 'google'] as const).filter((p) => mail.providers[p]) : [];
  return (
    <div className="space-y-6">
      <StepHeader title="Know more about you" sub="Paste your LinkedIn text or upload its PDF, or point your twin to a site you own. It learns from them so you don’t have to type it all." />
      <section className="space-y-3 rounded-2xl border border-line bg-panel/60 p-4">
        <h2 className="font-medium">Email</h2>
        <p className="text-sm text-muted">Learn your orders and trips from confirmation emails (Amazon.de, Booking.com, Skyscanner). Read-only, those senders only, raw emails never kept.</p>
        <MailboxBanner />
        {mail?.demo && <DemoNote mailboxes={mail.demo.mailboxes} />}
        {mail?.mailboxes.length ? <Mailboxes /> : mail?.demo && !mail.demo.allowed ? null : !mailOpen ? (
          <Button variant="ghost" disabled={!providers.length} onClick={async () => {
            setMailError(null);
            try {
              for (const slug of MAIL_SERVICES) await api(`/store/${slug}/activate`, { body: {} });
              setMailOpen(true);
            } catch (err) {
              setMailError(err instanceof ApiError ? err.message : 'Couldn’t prepare the mailbox.');
            }
          }}>{providers.length ? 'Learn from my email' : 'Email connection coming soon'}</Button>
        ) : (
          <div className="flex gap-2">
            {providers.map((p) => <a key={p} href={`/api/connections/${p}/start?window=3`} className="flex-1 rounded-full bg-white py-2.5 text-center text-sm font-medium text-black">Connect {p === 'microsoft' ? 'Outlook' : 'Gmail'}</a>)}
          </div>
        )}
        {mailError && <p className="text-sm text-bad">{mailError}</p>}
      </section>
      <section className="space-y-3 rounded-2xl border border-line bg-panel/60 p-4">
        <h2 className="font-medium">Profiles and websites</h2>
        <LinksEditor />
      </section>
      <StepNav onNext={onNext} onLater={onLater} />
    </div>
  );
}

// --- Interests ---

export function Interests({ onNext, onLater }: { onNext(): void; onLater(): void }) {
  const { iperson } = useSession();
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const q = INTEREST_QUESTIONS[i]!;
  const picked = answers[q.key] ?? [];
  const toggle = (o: string) => setAnswers((a) => ({
    ...a, [q.key]: q.multi ? (picked.includes(o) ? picked.filter((x) => x !== o) : [...picked, o]) : [o],
  }));
  const next = async () => {
    const withOther = other.trim() ? { ...answers, [q.key]: [...picked, other.trim()] } : answers;
    setAnswers(withOther);
    setOther('');
    if (i < INTEREST_QUESTIONS.length - 1) return setI(i + 1);
    setBusy(true);
    await api(`/ipersons/${iperson!.id}/interests`, { body: { answers: withOther } });
    onNext();
  };
  return (
    <div className="space-y-6">
      <p className="text-xs uppercase tracking-wider text-muted">Your interests · {i + 1} / {INTEREST_QUESTIONS.length}</p>
      <StepHeader title={q.q} sub={q.multi ? 'Tap all that fit.' : 'Tap one.'} />
      <div className="flex flex-wrap gap-2">{q.options.map((o) => <button key={o} type="button" onClick={() => toggle(o)} className={chip(picked.includes(o))}>{o}</button>)}</div>
      <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Something else? (optional)"
        className="w-full rounded-xl border border-line bg-panel px-4 py-3 text-sm outline-none focus:border-rim/60" />
      <StepNav busy={busy} onNext={next} onLater={onLater} label={i < INTEREST_QUESTIONS.length - 1 ? 'Next' : 'Done'} />
    </div>
  );
}

// --- Rules ---

interface Rule { id: string; kind: 'do' | 'dont'; text: string; source: RuleSource; sourceNote: string | null; active: boolean; hits: number }

/** The do / don't list with where each rule came from; used in setup and on My twin. */
export function RulesEditor({ compact }: { compact?: boolean }) {
  const { iperson } = useSession();
  const [rules, setRules] = useState<Rule[]>([]);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'do' | 'dont'>('dont');
  const load = () => api<{ rules: Rule[] }>(`/ipersons/${iperson!.id}/rules`).then((r) => setRules(r.rules)).catch(() => {});
  useEffect(() => { void load(); }, []);
  const add = async (k: 'do' | 'dont', t: string, source: 'user' | 'onboarding' = 'user') => {
    await api(`/ipersons/${iperson!.id}/rules`, { body: { source, rules: [{ kind: k, text: t }] } });
    await load();
  };
  const have = new Set(rules.map((r) => r.text));
  return (
    <div className="space-y-4">
      {(['do', 'dont'] as const).map((k) => (
        <div key={k} className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-muted">{k === 'do' ? 'Always' : 'Never'}</h3>
          {rules.filter((r) => r.kind === k).map((r) => (
            <div key={r.id} className={`flex items-start justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-2.5 text-sm ${r.active ? '' : 'opacity-50'}`}>
              <div className="min-w-0">
                <p>{r.text}</p>
                <p className="mt-0.5 text-xs text-muted" title={r.sourceNote ?? undefined}>
                  {RULE_SOURCE_LABELS[r.source]}{r.sourceNote ? ` · ${r.sourceNote}` : ''}{r.hits ? ` · corrected ${r.hits}×` : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-3 text-xs text-muted">
                {!compact && <button className="hover:text-white" onClick={async () => { await api(`/ipersons/${iperson!.id}/rules/${r.id}`, { method: 'PATCH', body: { active: !r.active } }); await load(); }}>{r.active ? 'Pause' : 'Resume'}</button>}
                <button className="hover:text-white" onClick={async () => { await api(`/ipersons/${iperson!.id}/rules/${r.id}`, { method: 'DELETE' }); await load(); }}>Remove</button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {RULE_SUGGESTIONS[k].filter((s) => !have.has(s)).map((s) => (
              <button key={s} type="button" onClick={() => add(k, s, compact ? 'onboarding' : 'user')} className="rounded-full border border-dashed border-line px-3 py-1.5 text-xs text-muted hover:border-white/40 hover:text-white">+ {s}</button>
            ))}
          </div>
        </div>
      ))}
      <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (text.trim().length < 3) return; await add(kind, text.trim(), compact ? 'onboarding' : 'user'); setText(''); }}>
        <button type="button" onClick={() => setKind(kind === 'do' ? 'dont' : 'do')} className="shrink-0 rounded-full border border-line px-3 text-xs">{kind === 'do' ? 'Always' : 'Never'}</button>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="Your own rule…"
          className="min-w-0 flex-1 rounded-full border border-line bg-panel px-4 py-2.5 text-sm outline-none focus:border-rim/60" />
        <Button disabled={text.trim().length < 3}>Add</Button>
      </form>
    </div>
  );
}

export function Rules({ onNext, onLater }: { onNext(): void; onLater(): void }) {
  return (
    <div className="space-y-6">
      <StepHeader title="Your i-person’s rules" sub="What it should always do, and never do. A checker reviews every answer against this list before you see it. Rules you say in chat, or that it learns from you, are added here with where they came from." />
      <RulesEditor compact />
      <StepNav onNext={onNext} onLater={onLater} />
    </div>
  );
}

// --- Preferred sources ---

export function SourcesPicker({ onSaved, footer }: { onSaved?(): void; footer?: (save: () => Promise<void>, busy: boolean) => ReactNode }) {
  const { user, iperson } = useSession();
  // DEMO: demo accounts pick from the neutral demo services only, no real brands.
  const categories: readonly { id: string; label: string; providers: readonly (readonly [string, string, string])[] }[] = isDemoAccount(user?.account_kind) ? DEMO_PROVIDER_CATEGORIES : PROVIDER_CATEGORIES;
  const [order, setOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<{ sources: { provider: string }[] }>(`/ipersons/${iperson!.id}/sources`).then((r) => setOrder(r.sources.map((s) => s.provider))).catch(() => {});
  }, []);
  const toggle = (id: string) => { setSaved(false); setOrder((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id])); };
  const save = async () => {
    setBusy(true);
    await api(`/ipersons/${iperson!.id}/sources`, { method: 'PUT', body: { providers: order } });
    setBusy(false);
    setSaved(true);
    onSaved?.();
  };
  return (
    <div className="space-y-5">
      {categories.map((c) => {
        const ranked = order.filter((id) => (c.providers as readonly (readonly string[])[]).some((p) => p[0] === id));
        return (
          <div key={c.id}>
            <h3 className="mb-2 text-xs uppercase tracking-wider text-muted">{c.label}</h3>
            <div className="flex flex-wrap gap-2">
              {c.providers.map(([id, name]) => {
                const rank = ranked.indexOf(id) + 1;
                return (
                  <button key={id} type="button" onClick={() => toggle(id)} className={chip(rank > 0)}>
                    {rank > 0 && <span className="mr-1.5 inline-grid h-5 w-5 place-items-center rounded-full bg-black text-[11px] text-white">{rank}</span>}
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {footer ? footer(save, busy) : <div className="flex items-center gap-3"><Button disabled={busy} onClick={save}>Save</Button>{saved && <span className="text-sm text-ok">Saved</span>}</div>}
    </div>
  );
}

export function Sources({ onNext, onLater }: { onNext(): void; onLater(): void }) {
  return (
    <div className="space-y-6">
      <StepHeader title="Where should I look?" sub="Pick the sites you trust in each area, in order: the first one you tap is the one your twin checks first for insights and recommendations." />
      <SourcesPicker footer={(save, busy) => <StepNav busy={busy} onNext={async () => { await save(); onNext(); }} onLater={onLater} />} />
    </div>
  );
}

// --- Warm-up: the twin's first suggestion ---

export function Warmup({ onDone }: { onDone(): void }) {
  const { user, iperson } = useSession();
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const speaker = useRef(new Speaker());
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<{ reply: string }>(`/ipersons/${iperson!.id}/warmup`, { method: 'POST' })
      .then((r) => { setReply(r.reply); speaker.current.speakText(r.reply, user?.locale ?? 'en'); })
      .catch(() => setError(true));
  }, []);
  return (
    <div className="space-y-6 text-center">
      <div className="flex justify-center">
        <Avatar imageUrl={iperson?.avatarUrl ?? null} mouth={iperson?.avatarMeta?.mouth} level={() => speaker.current.level()} state={reply ? 'idle' : 'thinking'} size={220} />
      </div>
      {!reply && !error && <StepHeader title={`${iperson?.displayName ?? 'Your i-person'} is warming up…`} sub="Reading everything you shared and looking for a first idea for you." />}
      {reply && <p className="text-xl leading-relaxed">{reply}</p>}
      {error && <p className="text-muted">Your twin is ready. Say hi on Talk!</p>}
      {(reply || error) && <Button className="w-full py-3" onClick={() => { speaker.current.unlock(); onDone(); }}>Talk to {iperson?.displayName ?? 'my i-person'}</Button>}
    </div>
  );
}
