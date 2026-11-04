import { useEffect, useState, type FormEvent } from 'react';
import { ComingSoon } from './ComingSoon.tsx';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { Button, Field } from '../components/ui.tsx';
import { useSession } from '../session.tsx';

const MESSAGES: Record<string, string> = {
  email_taken: 'An account with this email already exists.',
  wrong_email_or_password: 'Wrong email or password.',
  invalid: 'Check the fields: password needs 8+ characters.',
  country_not_allowed: 'That invite code isn’t valid (or is used up).',
  // Sign-in with Google / Microsoft / Facebook comes back with ?error=…
  provider_unavailable: 'That sign-in option isn’t available right now.',
  expired: 'The sign-in took too long. Please try again.',
  cancelled: 'Sign-in was cancelled.',
  no_email: 'We couldn’t get a verified email from that account.',
  account_suspended: 'This account is suspended. Contact contact@i-persons.com.',
  rate_limited: 'Too many attempts. Please wait a few minutes.',
};

const PROVIDERS = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'microsoft', label: 'Continue with Microsoft' },
  { id: 'facebook', label: 'Continue with Facebook' },
] as const;

export function Auth({ mode }: { mode: 'login' | 'signup' }) {
  const nav = useNavigate();
  const { refresh } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Part C: outside the allowed countries, sign-up shows "coming soon" unless the user has an invite code.
  const [blocked, setBlocked] = useState<{ country: string | null } | null>(null);
  const savedInvite = (() => { try { return new URLSearchParams(location.search).get('invite') ?? localStorage.getItem('ip_invite') ?? ''; } catch { return ''; } })();
  const [withInvite, setWithInvite] = useState(Boolean(savedInvite));
  const [providers, setProviders] = useState<Record<string, boolean>>({});
  const [invite, setInvite] = useState(savedInvite);
  // A personal invite link (/join/<token>) opened earlier in this browser.
  const join = (() => { try { return localStorage.getItem('ip_join') ?? ''; } catch { return ''; } })();
  useEffect(() => {
    api<Record<string, boolean>>('/auth/providers').then(setProviders).catch(() => {});
    const e = new URLSearchParams(location.search).get('error');
    if (e === 'country_not_allowed') setBlocked({ country: null });
    else if (e) setError(MESSAGES[e] ?? 'Sign-in failed. Please try again.');
  }, []);
  useEffect(() => {
    if (mode !== 'signup') return;
    api<{ country: string | null; allowed: boolean }>('/auth/country').then((r) => { if (!r.allowed) setBlocked({ country: r.country }); }).catch(() => {});
  }, [mode]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api(`/auth/${mode === 'login' ? 'login' : 'register'}`, {
        body: { email: f.get('email'), password: f.get('password'), ...(mode === 'signup' ? { name: f.get('name'), invite_code: f.get('invite') || undefined, join_token: join || undefined } : {}) },
      });
      try { localStorage.removeItem('ip_invite'); } catch { /* ignore */ }
      await refresh();
      nav('/onboarding'); // finished accounts are sent on to Talk
    } catch (err) {
      if (err instanceof ApiError && err.code === 'country_not_allowed' && !(mode === 'signup' && withInvite)) {
        setBlocked({ country: null });
        return;
      }
      setError(err instanceof ApiError ? MESSAGES[err.code] ?? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  if (blocked && !withInvite) return <ComingSoon country={blocked.country} onInvite={() => setWithInvite(true)} />;

  return (
    <div className="rim-glow grid min-h-full place-items-center px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <Link to="/" className="block text-center font-semibold tracking-tight">i-persons</Link>
        <h1 className="pb-2 text-center text-2xl font-semibold">{mode === 'login' ? 'Welcome back' : 'Create your i-person'}</h1>
        {mode === 'signup' && (withInvite || blocked) && <Field label="Invite code" name="invite" required={Boolean(blocked)} autoComplete="off" value={invite} onChange={(e) => setInvite(e.target.value)} />}
        {PROVIDERS.filter((p) => providers[p.id]).map((p) => (
          <a key={p.id} href={`/api/auth/oauth/${p.id}/start?${new URLSearchParams({ ...(invite.trim() ? { invite: invite.trim() } : {}), ...(join ? { join } : {}) })}`}
            className="flex w-full items-center justify-center gap-3 rounded-full border border-line bg-panel py-3 text-sm font-medium hover:border-white/40">
            <ProviderMark id={p.id} />{p.label}
          </a>
        ))}
        {PROVIDERS.some((p) => providers[p.id]) && <p className="flex items-center gap-3 text-xs uppercase tracking-wider text-muted"><span className="h-px flex-1 bg-line" />or with email<span className="h-px flex-1 bg-line" /></p>}
        {mode === 'signup' && <Field label="Your name" name="name" required autoComplete="name" />}
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        <Field label="Password" name="password" type="password" required minLength={mode === 'signup' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        {error && <p className="text-sm text-bad">{error}</p>}
        <Button disabled={busy} className="w-full py-3">{busy ? '…' : mode === 'login' ? 'Sign in' : 'Continue'}</Button>
        <p className="text-center text-sm text-muted">
          {mode === 'login' ? <>New here? <Link to="/signup" className="text-white underline">Create an account</Link></>
            : <>Have an account? <Link to="/login" className="text-white underline">Sign in</Link></>}
        </p>
      </form>
    </div>
  );
}

/** Small neutral marks (no brand logos drawn in code): the provider's initial in a circle. */
function ProviderMark({ id }: { id: string }) {
  return <span aria-hidden className="grid h-6 w-6 place-items-center rounded-full bg-white text-xs font-bold text-black">{id[0]!.toUpperCase()}</span>;
}
