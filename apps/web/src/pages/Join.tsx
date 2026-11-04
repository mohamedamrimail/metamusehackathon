import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.ts';
import { useSession } from '../session.tsx';
import { ComingSoon } from './ComingSoon.tsx';

// i-persons.com/join/<token> — a personal invite (§3c). Shows who invited you, then normal sign-up.
// It does not get anyone past the country gate unless the admin allows it.

interface InviteInfo { inviter: string; valid: boolean; country_allowed: boolean; country: string | null }

export const JOIN_KEY = 'ip_join';

export function Join() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const { user } = useSession();
  const [info, setInfo] = useState<InviteInfo | null | 'missing'>(null);
  useEffect(() => {
    api<InviteInfo>(`/invites/${encodeURIComponent(token)}`).then(setInfo).catch(() => setInfo('missing'));
  }, [token]);
  useEffect(() => {
    // Kept for after sign-up (also across a Google/Microsoft redirect).
    try { localStorage.setItem(JOIN_KEY, token); } catch { /* storage blocked */ }
  }, [token]);

  if (info === null) return <div className="grid h-full place-items-center text-muted">Loading…</div>;
  if (info === 'missing' || !info.valid) {
    return (
      <div className="rim-glow grid min-h-full place-items-center px-4 py-10 text-center">
        <div className="max-w-sm space-y-4">
          <h1 className="text-2xl font-semibold">This invite has expired</h1>
          <p className="text-muted">Invites are valid for 30 days. You can still create your i-person.</p>
          <Link to="/signup" className="inline-block rounded-full bg-white px-5 py-2.5 text-sm font-medium text-black">Create your i-person</Link>
        </div>
      </div>
    );
  }
  if (!info.country_allowed) return <ComingSoon country={info.country} invitedBy={info.inviter} onInvite={() => nav('/signup?invite=')} />;
  return (
    <div className="rim-glow grid min-h-full place-items-center px-4 py-10 text-center">
      <div className="max-w-sm space-y-5">
        <img src="/favicon.svg" alt="" className="mx-auto h-14 w-14" />
        <h1 className="text-2xl font-semibold">{info.inviter} invited you</h1>
        <p className="text-muted">i-persons gives you a digital twin that plans with you and never acts without your yes. Once you’re in, your twin and {info.inviter}’s can set up coffees, dinners and meetings for you both.</p>
        {user ? <Link to="/contacts" className="inline-block rounded-full bg-white px-5 py-2.5 text-sm font-medium text-black">Open i-persons</Link>
          : <Link to="/signup" className="inline-block rounded-full bg-white px-5 py-2.5 text-sm font-medium text-black">Create your i-person</Link>}
        <p className="text-xs text-muted">Already have an account? <Link to="/login" className="underline">Sign in</Link></p>
      </div>
    </div>
  );
}
