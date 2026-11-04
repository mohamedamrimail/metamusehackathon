import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Panel } from './ui.tsx';

// Offers partners matched to you (P5 delivery), with dismiss, pause and report (P6).

interface Offer { id: string; partner: string; partner_slug: string; verified: boolean; type: string; title: string; description: string; location: string | null; remote: boolean; link: string | null; score: number; reason: string; open: boolean }

export function OffersPanel() {
  const [list, setList] = useState<Offer[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => api<{ offers: Offer[] }>('/me/offers').then((r) => setList(r.offers)).catch(() => setList([])), []);
  useEffect(() => void load(), [load]);
  if (!list?.length) return null;
  return (
    <Panel title="Offers for you" aside={<span className="text-xs text-muted">from services you activated</span>}>
      {note && <p className="mb-2 text-xs text-muted">{note}</p>}
      <ul className="space-y-2">
        {list.map((o) => (
          <li key={o.id} className="rounded-xl border border-line p-3 text-sm">
            <p className="text-xs text-muted">{o.partner}{o.verified ? ' · verified' : ''} · {o.type}{o.location ? ` · ${o.location}` : ''}{o.remote ? ' · remote' : ''}</p>
            <p className="font-medium">{o.link ? <a href={o.link} target="_blank" rel="noreferrer" className="underline">{o.title}</a> : o.title}</p>
            <p className="text-muted">{o.reason}</p>
            <div className="mt-2 flex gap-3 text-xs">
              <button className="text-muted" onClick={async () => { await api(`/me/offers/${o.id}/dismiss`, { method: 'POST' }); void load(); }}>Not for me</button>
              <button className="text-muted" onClick={async () => { await api(`/me/partners/${o.partner_slug}/block`, { body: { blocked: true } }); setNote(`${o.partner} is paused: no more offers or conversations.`); }}>Pause {o.partner}</button>
              <button className="text-bad" onClick={async () => {
                const reason = prompt(`What's wrong with ${o.partner}?`);
                if (reason && reason.trim().length >= 3) { await api(`/me/partners/${o.partner_slug}/report`, { body: { reason } }); setNote('Thanks, we’ll look into it.'); }
              }}>Report</button>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

interface Conv { id: string; partner: string; partner_slug: string; offer: string; at: string; summary: string; transcript: { role: string; text: string; at: string }[] }

/** Activity: what partners asked your twin, with transcripts (P6). */
export function PartnerActivity() {
  const [list, setList] = useState<Conv[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api<{ conversations: Conv[] }>('/me/partner-activity').then((r) => setList(r.conversations)).catch(() => {}); }, []);
  if (!list.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs uppercase tracking-wider text-muted">Partners talking to your twin</h2>
      {list.map((c) => (
        <div key={c.id} className="rounded-xl border border-line p-3 text-sm">
          <button className="w-full text-left" onClick={() => setOpen(open === c.id ? null : c.id)}>
            <span className="font-medium">{c.summary}</span> <span className="text-muted">about “{c.offer}” · {new Date(c.at).toLocaleString()}</span>
          </button>
          {open === c.id && (
            <div className="mt-2 space-y-1 border-t border-line pt-2">
              {c.transcript.map((m, i) => <p key={i} className={m.role === 'partner' ? 'text-white/70' : ''}><span className="text-xs text-muted">{m.role === 'partner' ? c.partner : 'Your twin'}: </span>{m.text}</p>)}
              <button className="text-xs text-bad" onClick={async () => {
                const reason = prompt(`Report ${c.partner}: what happened?`);
                if (reason && reason.trim().length >= 3) await api(`/me/partners/${c.partner_slug}/report`, { body: { reason } });
              }}>Report partner</button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

interface VisitorConv { id: string; visitor: string; email: string | null; phone: string | null; at: string; notes: string[]; transcript: { role: string; text: string }[] }

/** Activity → Conversations with others (Phase 6c): visitors on your public page. */
export function VisitorActivity() {
  const [list, setList] = useState<VisitorConv[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api<{ conversations: VisitorConv[] }>('/me/visitor-activity').then((r) => setList(r.conversations)).catch(() => {}); }, []);
  if (!list.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs uppercase tracking-wider text-muted">Conversations with others</h2>
      {list.map((c) => (
        <div key={c.id} className="rounded-xl border border-line p-3 text-sm">
          <button className="w-full text-left" onClick={() => setOpen(open === c.id ? null : c.id)}>
            <span className="font-medium">{c.visitor}</span> <span className="text-muted">{[c.email, c.phone].filter(Boolean).join(' · ')} · {new Date(c.at).toLocaleString()}</span>
            {c.notes.length > 0 && <span className="ml-2 rounded-full bg-rim/20 px-2 py-0.5 text-[10px] text-rim">{c.notes.length} message{c.notes.length > 1 ? 's' : ''} for you</span>}
          </button>
          {open === c.id && (
            <div className="mt-2 space-y-1 border-t border-line pt-2">
              {c.notes.map((n, i) => <p key={`n${i}`} className="rounded-lg bg-rim/10 px-2 py-1">✉ {n}</p>)}
              {c.transcript.map((m, i) => <p key={i} className={m.role === 'visitor' ? 'text-white/70' : ''}><span className="text-xs text-muted">{m.role === 'visitor' ? c.visitor : 'Your twin'}: </span>{m.text}</p>)}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
