import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Button } from './ui.tsx';
import { useFeatures } from '../features.ts';

// My twin → Glasses: pair Meta Ray-Ban Display glasses with the /glasses web app (a QR code the glasses scan).

interface Device { id: string; label: string; created_at: string; last_seen_at: string | null }

export function GlassesPanel() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [pair, setPair] = useState<{ qr: string; url: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<{ devices: Device[] }>('/me/glasses').then((r) => setDevices(r.devices)).catch(() => {}), []);
  useEffect(() => void load(), [load]);
  const start = async () => {
    setMsg(null);
    try {
      const r = await api<{ install_link: string; url: string }>('/me/glasses', { body: {} });
      setPair({ qr: await QRCode.toDataURL(r.install_link, { margin: 1, width: 480 }), url: r.url });
      void load();
    } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Could not pair'); }
  };
  const features = useFeatures();
  if (features && !features.glasses) {
    return <p className="text-sm text-muted">Glasses: not configured on this server. Meta Ray-Ban Display glasses open a public HTTPS address, so set PUBLIC_URL to one (for example https://i-persons.com).</p>;
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">See your twin on <strong className="text-white">Meta Ray-Ban Display</strong> glasses: it floats in view, says its replies, and you approve or decline cards with the Neural Band. Ask by typing or dictating.</p>
      {pair ? (
        <div className="space-y-2">
          <img src={pair.qr} alt="Pairing code for the glasses" className="mx-auto w-56 rounded-xl bg-white p-2" />
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>On your phone, in the Meta AI app: Settings → App info, tap the version 5 times (Developer Mode).</li>
            <li>Look at this code with your glasses and confirm “i-persons”.</li>
            <li>This code is a key to your twin until you remove the glasses below: don’t share it.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <button className="rounded-full border border-line px-3 py-1.5 hover:border-white" onClick={() => { void navigator.clipboard?.writeText(pair.url).then(() => setMsg('Link copied: paste it in the Meta Ray-Ban Display Simulator.')); }}>Copy link for the simulator</button>
            <button className="underline" onClick={() => setPair(null)}>Done</button>
          </div>
        </div>
      ) : <Button variant="ghost" onClick={() => void start()}>Pair my glasses</Button>}
      {devices.length > 0 && (
        <ul className="divide-y divide-line">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center justify-between py-2">
              <span>{d.label} <span className="text-muted">· {d.last_seen_at ? `last seen ${new Date(d.last_seen_at).toLocaleString()}` : 'not opened yet'}</span></span>
              <button className="text-xs text-bad underline" onClick={async () => { await api(`/me/glasses/${d.id}`, { method: 'DELETE' }); void load(); }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className={`text-xs ${msg.startsWith('Link copied') ? 'text-ok' : 'text-bad'}`}>{msg}</p>}
    </div>
  );
}
