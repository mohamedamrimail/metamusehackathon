import { DISCOVERABILITY_TEXT, type Discoverability } from '@ipersons/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Panel } from './ui.tsx';

/** My twin → Privacy: who may see that I have an i-person (contacts matching, docs/twin-to-twin.md §1). */
export function PrivacyPanel() {
  const [value, setValue] = useState<Discoverability | null>(null);
  useEffect(() => { api<{ discoverability: Discoverability }>('/me/discoverability').then((r) => setValue(r.discoverability)).catch(() => {}); }, []);
  const set = async (d: Discoverability) => {
    setValue(d);
    await api('/me/discoverability', { method: 'PUT', body: { discoverability: d } }).catch(() => {});
  };
  return (
    <Panel title="Privacy">
      <p className="mb-3 text-sm">Let people who have my email or phone number see that I have an i-person.</p>
      <div className="grid gap-2">
        {([
          ['contacts', 'People who have me in their contacts', 'Only my verified email or WhatsApp number, only in their synced contacts.'],
          ['nobody', 'Nobody', 'I can still invite and connect with people myself.'],
        ] as const).map(([id, title, detail]) => (
          <label key={id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm ${value === id ? 'border-rim/60 bg-rim/5' : 'border-line'}`}>
            <input type="radio" name="discoverability" checked={value === id} onChange={() => void set(id)} className="mt-0.5 accent-white" />
            <span><span className="block font-medium">{title}</span><span className="text-xs text-muted">{detail}</span></span>
          </label>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">{DISCOVERABILITY_TEXT}</p>
    </Panel>
  );
}
