import { AGE_RANGES, CONSENT_TEXT, CONSENT_VERSION, GENDERS, type AgeRange, type Gender } from '@ipersons/shared';
import { useState } from 'react';
import { api } from '../api.ts';
import { Button } from '../components/ui.tsx';
import { useSession } from '../session.tsx';

/** First onboarding screen, and the re-consent screen when the consent text changes. */
export function ProfileStep() {
  const { user, refresh } = useSession();
  const [gender, setGender] = useState<Gender | null>((user?.gender as Gender | null) ?? null);
  const [age, setAge] = useState<AgeRange | null>((user?.age_range as AgeRange | null) ?? null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const returning = Boolean(user?.gender && user.age_range);
  const chip = (on: boolean) => `rounded-xl border px-3 py-2.5 text-sm ${on ? 'border-white bg-white text-black' : 'border-line bg-panel'}`;

  return (
    <div className="rim-glow min-h-full px-4 py-8">
      <form className="mx-auto max-w-lg space-y-6" onSubmit={async (e) => {
        e.preventDefault();
        if (!gender || !age || !agreed) return;
        setBusy(true);
        await api('/me/profile', { method: 'PATCH', body: { gender, age_range: age, consent_version: CONSENT_VERSION } });
        await refresh();
      }}>
        <span className="font-semibold tracking-tight">i-persons</span>
        <h1 className="text-3xl font-semibold">{returning ? 'We updated our terms' : 'A bit about you'}</h1>
        <p className="text-muted">Used only to shape your avatar and suggest a voice. Never shown publicly or given to your twin.</p>

        <fieldset>
          <legend className="mb-2 text-xs uppercase tracking-wider text-muted">Gender</legend>
          <div className="grid grid-cols-3 gap-2">
            {GENDERS.map((g) => <button key={g.id} type="button" aria-pressed={gender === g.id} onClick={() => setGender(g.id)} className={chip(gender === g.id)}>{g.label}</button>)}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-xs uppercase tracking-wider text-muted">Age</legend>
          <div className="grid grid-cols-3 gap-2">
            {AGE_RANGES.map((a) => <button key={a} type="button" aria-pressed={age === a} onClick={() => setAge(a)} className={chip(age === a)}>{a}</button>)}
          </div>
          <p className="mt-2 text-xs text-muted">i-persons is for adults only.</p>
        </fieldset>

        <label className="flex gap-3 rounded-xl border border-line bg-panel p-4 text-sm">
          <input type="checkbox" required checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-white" />
          <span>
            {CONSENT_TEXT}{' '}
            <a href="/terms.html" target="_blank" className="underline">Terms</a> · <a href="/privacy.html" target="_blank" className="underline">Privacy</a>
          </span>
        </label>

        <Button className="w-full py-3" disabled={busy || !gender || !age || !agreed}>Continue</Button>
      </form>
    </div>
  );
}
