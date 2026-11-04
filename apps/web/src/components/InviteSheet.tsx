import type { ContactView } from '@ipersons/shared';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Button } from './ui.tsx';

// §3 Invite a contact: by email (sent by i-persons when you tap Send) or by WhatsApp (sent by YOU from
// your own WhatsApp; the i-persons number never messages people who didn't ask for it).

interface Prefill { text: string; emails: string[]; phones: string[]; reply_to_available: boolean; invited: { channel: string; at: string; reminded: boolean } | null }

export function InviteSheet({ c, onDone }: { c: ContactView; onDone(): void }) {
  const [p, setP] = useState<Prefill | null>(null);
  const [channel, setChannel] = useState<'email' | 'whatsapp'>('email');
  const [email, setEmail] = useState('');
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remind = c.status === 'invited';

  useEffect(() => {
    api<Prefill>(`/contacts/${c.id}/invite`).then((r) => {
      setP(r);
      setText(r.text);
      setEmail(r.emails[0] ?? '');
      setChannel(r.emails.length ? 'email' : 'whatsapp');
    }).catch(() => setMsg('Could not load the invite.'));
  }, [c.id]);
  if (!p) return <p className="text-sm text-muted">{msg ?? 'Loading…'}</p>;

  const send = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (channel === 'email') {
        const r = await api<{ outbox?: boolean }>(`/contacts/${c.id}/invite`, { body: { channel, email, message: text, reply_to: replyTo, remind } });
        setMsg(r.outbox ? 'Saved in your outbox (email sending isn’t set up on this server).' : 'Invite sent.');
        setTimeout(onDone, 900);
      } else {
        // Recorded first, then your WhatsApp opens with the text ready: you press send there.
        const r = await api<{ wa_link?: string; share_text?: string; text: string }>(`/contacts/${c.id}/invite`, { body: { channel, message: text, remind } });
        if (r.wa_link) location.href = r.wa_link;
        else if (navigator.share) await navigator.share({ text: r.share_text ?? r.text }).catch(() => {});
        else await navigator.clipboard?.writeText(r.share_text ?? r.text).then(() => setMsg('Copied: paste it in WhatsApp.')).catch(() => {});
        onDone();
      }
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{remind ? `Remind ${c.name}` : `Invite ${c.name}`}</h2>
      {p.invited && <p className="text-xs text-muted">Invited by {p.invited.channel} on {new Date(p.invited.at).toLocaleDateString()}{p.invited.reminded ? ', reminded once' : ''}.</p>}
      <div className="flex gap-2">
        <button disabled={!p.emails.length} onClick={() => setChannel('email')}
          className={`flex-1 rounded-full border px-3 py-2 text-sm disabled:opacity-30 ${channel === 'email' ? 'border-white bg-white text-black' : 'border-line'}`}>Email</button>
        <button onClick={() => setChannel('whatsapp')}
          className={`flex-1 rounded-full border px-3 py-2 text-sm ${channel === 'whatsapp' ? 'border-white bg-white text-black' : 'border-line'}`}>WhatsApp</button>
      </div>
      {channel === 'email' && p.emails.length > 1 && (
        <select value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm">
          {p.emails.map((e) => <option key={e}>{e}</option>)}
        </select>
      )}
      {channel === 'email' && p.emails.length === 1 && <p className="truncate text-sm text-muted">To {email}</p>}
      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-wider text-muted">Message</span>
        <textarea value={text} maxLength={600} rows={5} onChange={(e) => setText(e.target.value)}
          className="w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-rim/60" />
        <span className="text-xs text-muted">Your personal link (valid 30 days) is added below the message.</span>
      </label>
      {channel === 'email' && p.reply_to_available && (
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={replyTo} onChange={(e) => setReplyTo(e.target.checked)} className="accent-white" />Replies come to my email</label>
      )}
      {channel === 'email'
        ? <p className="text-xs text-muted">Sent from contact@i-persons.com as “you via i-persons”, with a one-click “Don’t send me invites again”.</p>
        : <p className="text-xs text-muted">Opens your own WhatsApp with the message ready{p.phones.length ? '' : ' (or your share sheet: this contact has no number)'}. i-persons doesn’t send it for you.</p>}
      <Button className="w-full" disabled={busy || (channel === 'email' && !email)} onClick={send}>
        {channel === 'email' ? (remind ? 'Send reminder' : 'Send') : p.phones.length ? 'Open WhatsApp' : 'Share…'}
      </Button>
      {msg && <p className="text-sm text-muted">{msg}</p>}
    </div>
  );
}
