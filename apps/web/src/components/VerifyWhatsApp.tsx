import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Button } from './ui.tsx';

// Phase 2: user-initiated WhatsApp verification. The user sends "VERIFY <code>" from their phone,
// which proves the number and opens the 24-hour window for the avatar welcome.

interface Code { code: string; number: string | null; wa_link: string | null; enabled: boolean; verified: boolean; phone: string | null }

export function VerifyWhatsApp({ onVerified, onSkip }: { onVerified(): void; onSkip?(): void }) {
  const [c, setC] = useState<Code | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    api<Code>('/me/whatsapp/code', { method: 'POST' }).then(async (r) => {
      setC(r);
      if (r.verified) onVerified();
      if (r.wa_link) setQr(await QRCode.toDataURL(r.wa_link, { margin: 1, width: 360, color: { dark: '#000000', light: '#ffffff' } }));
    }).catch(() => {});
    // Wait for the webhook to verify (the user sends the message from their phone).
    const t = setInterval(() => {
      api<{ verified: boolean }>('/me/whatsapp').then((r) => { if (r.verified) onVerified(); }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [onVerified]);

  if (!c) return <p className="text-muted">Loading…</p>;
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-semibold">Verify your WhatsApp</h1>
      <p className="text-muted">Every i-person belongs to a real, reachable person. Send the code to your twin on WhatsApp — it will greet you there.</p>
      {!c.enabled || !c.wa_link ? (
        <p className="text-sm text-warn">WhatsApp: not configured on this server (WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID and WA_PHONE_NUMBER are not set). You can skip this step; features that need a verified number stay locked.</p>
      ) : (
        <>
          <p className="text-center text-4xl font-semibold tracking-[0.3em]">{c.code}</p>
          <a href={c.wa_link} target="_blank" rel="noreferrer" className="block rounded-full bg-[#25D366] py-3 text-center font-medium text-black">Send “VERIFY {c.code}” on WhatsApp</a>
          {qr && (
            <div className="hidden flex-col items-center gap-2 sm:flex">
              <img src={qr} alt="QR code that opens WhatsApp with the code" className="h-44 w-44 rounded-xl" />
              <p className="text-xs text-muted">On a computer? Scan this with your phone.</p>
            </div>
          )}
          <p className="text-center text-xs text-muted">Waiting for your message… The code is valid for 15 minutes.</p>
        </>
      )}
      {onSkip && (
        <div className="text-center">
          <button type="button" onClick={onSkip} className="text-sm text-muted underline">Skip for now (judges)</button>
          <p className="mt-1 text-xs text-muted">Without it you can talk to your twin, but not send emails, connect services or appear to partners.</p>
        </div>
      )}
    </div>
  );
}
