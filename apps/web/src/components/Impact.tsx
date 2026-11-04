import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import { Panel } from './ui.tsx';

// Impact §1: "time given back" on My twin, the public method page, and the optional landing counter.

interface Mine { week_minutes: number; week_text: string; total_text: string; weekly_summary: boolean }

export function TimeGivenBackPanel({ verified }: { verified: boolean }) {
  const [m, setM] = useState<Mine | null>(null);
  useEffect(() => { api<Mine>('/me/impact').then(setM).catch(() => {}); }, []);
  if (!m) return null;
  return (
    <Panel title="Time given back" aside={<Link to="/impact-method" className="text-xs underline">How we count</Link>}>
      <p className="text-lg">{m.week_minutes > 0 ? <>Your i-person gave you back about <strong>{m.week_text}</strong> this week.</> : 'Nothing counted this week yet.'}</p>
      <p className="mt-1 text-sm text-muted">Since you started: about {m.total_text}. Only actions you approved and that were completed count.</p>
      <label className={`mt-3 flex items-center gap-2 text-sm ${verified ? '' : 'opacity-50'}`}>
        <input type="checkbox" disabled={!verified} checked={m.weekly_summary} onChange={async (e) => {
          const on = e.target.checked;
          await api('/me/weekly-summary', { method: 'PATCH', body: { on } });
          setM({ ...m, weekly_summary: on });
        }} />
        Send me a weekly summary on WhatsApp{verified ? '' : ' (link your WhatsApp first)'}
      </label>
    </Panel>
  );
}

export function ImpactMethod() {
  const [d, setD] = useState<{ estimates: { kind: string; label: string; minutes: number; justification: string }[]; rule: string } | null>(null);
  useEffect(() => { api<NonNullable<typeof d>>('/impact/estimates').then(setD).catch(() => {}); }, []);
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-10">
      <Link to="/" className="text-sm font-semibold">i-persons</Link>
      <h1 className="text-3xl font-semibold">How we count time given back</h1>
      <p className="text-muted">Each action your i-person completes for you, with your approval, saves you a little time. We add up conservative estimates per type of action.</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-white/85">
        <li><strong>Only approved and completed actions count</strong>: never proposals, declined or expired ones.</li>
        <li>These are <strong>estimates</strong>, kept on the low side. When we change one, it applies from then on; past actions keep the estimate they were counted with.</li>
        <li>Team, judge and demo accounts are never counted in our totals.</li>
      </ul>
      {d && (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="pb-2">Action</th><th className="pb-2 text-right">Minutes</th><th className="pb-2 pl-4">Why</th></tr></thead>
          <tbody>{d.estimates.map((e) => (
            <tr key={e.kind} className="border-t border-line align-top"><td className="py-2">{e.label}</td><td className="py-2 text-right tabular-nums">{e.minutes}</td><td className="py-2 pl-4 text-muted">{e.justification}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

/** Landing: "Hours given back to our users", only when the admin switched it on. */
export function ImpactCounter() {
  const [h, setH] = useState<number | null>(null);
  useEffect(() => { api<{ show: boolean; hours?: number }>('/impact/total').then((r) => setH(r.show ? r.hours ?? 0 : null)).catch(() => {}); }, []);
  if (h === null) return null;
  return <p className="mt-6 text-sm text-muted"><strong className="text-white">{h.toLocaleString()} hours</strong> given back to our users · <Link to="/impact-method" className="underline">how we count</Link></p>;
}
