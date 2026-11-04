import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Panel } from './ui.tsx';

// Admin → Twins: invites, referral credit, connections and plans; settings for contacts & twin-to-twin.

interface TwinSettings {
  referralCreditUsd: number; referralMaxRewarded: number; invitesBypassCountry: boolean; invitesPerDay: number; connectRequestsPerDay: number; waTemplatesApproved: boolean;
}
interface Data {
  settings: TwinSettings;
  invites: { by_channel: Record<string, { sent: number; reminded: number }>; sent: number; signed_up: number; verified: number; referral_credit_usd: number; rewarded_invites: number };
  connections?: { by_status: Record<string, number>; paused_users: { name: string; email: string; until: string }[] };
  plans?: { by_status: Record<string, number> };
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');

export function TwinsAdmin() {
  const [d, setD] = useState<Data | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => api<Data>('/admin/twins').then(setD), []);
  useEffect(() => void load(), [load]);
  if (!d) return null;
  const save = async (patch: Partial<TwinSettings>) => {
    try {
      const r = await api<{ settings: TwinSettings }>('/admin/twins/settings', { method: 'PUT', body: patch });
      setD({ ...d, settings: r.settings });
      setNote('Saved — applies within 10 seconds.');
    } catch { setNote('Invalid value.'); }
  };
  const num = (k: keyof TwinSettings, label: string, step = 1) => (
    <label className="flex items-center justify-between gap-3 py-2 text-sm">
      <span>{label}</span>
      <input type="number" step={step} defaultValue={Number(d.settings[k])} className="w-28 rounded-full border border-line bg-ink px-3 py-1.5 text-right"
        onBlur={(e) => Number(e.target.value) !== d.settings[k] && void save({ [k]: Number(e.target.value) })} />
    </label>
  );
  const flag = (k: keyof TwinSettings, label: string) => (
    <label className="flex items-center justify-between gap-3 py-2 text-sm">
      <span>{label}</span>
      <input type="checkbox" checked={Boolean(d.settings[k])} onChange={(e) => void save({ [k]: e.target.checked })} className="h-5 w-5 accent-white" />
    </label>
  );
  const i = d.invites;
  return (
    <div className="space-y-4">
      <Panel title="Invites">
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {Object.entries(i.by_channel).map(([ch, v]) => <Stat key={ch} label={`Sent by ${ch}`} value={`${v.sent}`} sub={`${v.reminded} reminded`} />)}
          <Stat label="Signed up" value={`${i.signed_up}`} sub={pct(i.signed_up, i.sent)} />
          <Stat label="Verified" value={`${i.verified}`} sub={pct(i.verified, i.signed_up)} />
          <Stat label="Referral credit paid" value={`$${i.referral_credit_usd.toFixed(2)}`} sub={`${i.rewarded_invites} invites`} />
        </div>
      </Panel>
      {d.connections && (
        <Panel title="Twin connections">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            {Object.entries(d.connections.by_status).map(([s, n]) => <Stat key={s} label={s} value={`${n}`} />)}
          </div>
          {d.connections.paused_users.length > 0 && (
            <div className="mt-3 text-sm">
              <p className="text-xs uppercase tracking-wider text-warn">Paused for declines (3 in a week)</p>
              {d.connections.paused_users.map((u) => <p key={u.email} className="break-words">{u.name} · {u.email} · until {new Date(u.until).toLocaleString()}</p>)}
            </div>
          )}
        </Panel>
      )}
      {d.plans && (
        <Panel title="Plans">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {Object.entries(d.plans.by_status).map(([s, n]) => <Stat key={s} label={s.replace(/_/g, ' ')} value={`${n}`} />)}
          </div>
        </Panel>
      )}
      <Panel title="Settings">
        <div className="divide-y divide-line">
          {num('referralCreditUsd', 'Referral credit for both sides ($)', 0.5)}
          {num('referralMaxRewarded', 'Rewarded invites per user (max)')}
          {num('invitesPerDay', 'Invites per user per day')}
          {num('connectRequestsPerDay', 'Connection requests per user per day')}
          {flag('invitesBypassCountry', 'Personal invites bypass country gate')}
          {flag('waTemplatesApproved', 'WhatsApp twin templates approved by Meta')}
        </div>
        {note && <p className="mt-2 text-xs text-muted">{note}</p>}
      </Panel>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="text-xs capitalize text-muted">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}
