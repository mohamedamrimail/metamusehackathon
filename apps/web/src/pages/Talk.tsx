import { demoPromptsFor, TAP_LINES } from '@ipersons/shared';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { money } from '../api.ts';
import { useVoiceSession, type Card } from '../audio/useVoiceSession.ts';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.ts';
import type { Rig } from '../avatar/LivingAvatar.tsx';
import { Avatar } from '../avatar/Avatar.tsx';
import { FeedbackPrompt } from '../components/Feedback.tsx';
import { ChainPrompt } from '../components/Growth.tsx';
import { InstallApp } from '../components/InstallApp.tsx';
import { PendingMemoryCard, usePendingMemory } from '../components/PendingMemory.tsx';
import { Button, Chip } from '../components/ui.tsx';
import { useSession } from '../session.tsx';

// PixiJS is big: only Talk loads it, and the flat avatar shows until it's ready.
const LivingAvatar = lazy(() => import('../avatar/LivingAvatar.tsx').then((m) => ({ default: m.LivingAvatar })));


const SUGGESTIONS = ['Book yoga on Tuesday at 6pm', 'Send the invites for Sam’s party', "What's on my calendar this week?", 'Find me a beach trip'];

export function Talk() {
  const { user, iperson } = useSession();
  const s = useVoiceSession(iperson?.id, user?.locale ?? 'en');
  const demoPrompts = user?.account_kind === 'demo' ? demoPromptsFor(user.email) : undefined;
  const memory = usePendingMemory(iperson?.id);
  const { add: addMemory } = memory;
  useEffect(() => { if (s.heldMemory.length) addMemory(s.heldMemory); }, [s.heldMemory]); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  // The avatar shrinks on short screens so the conversation and the mic always fit.
  const view = useVisibleArea();
  const size = view.keyboard
    ? Math.max(84, Math.min(160, Math.round(view.height * 0.24)))
    : Math.max(140, Math.min(300, window.innerWidth - 48, Math.round(view.height * 0.32)));
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [s.lines, s.thinking, view.keyboard]);

  const lastTwin = [...s.lines].reverse().find((l) => l.who === 'twin');
  const nav = useNavigate();
  const [rig, setRig] = useState<Rig | null>(null);
  useEffect(() => {
    if (!iperson) return;
    const fallback: Rig = { alive: false, variants: { base: { url: iperson.avatarUrl ?? '', masks: { mouth: iperson.avatarMeta?.mouth } } } };
    api<{ rig: Rig }>(`/ipersons/${iperson.id}/avatar/life`).then((r) => setRig(r.rig)).catch(() => setRig(fallback));
  }, [iperson?.id, iperson?.avatarUrl]);
  // Smart scenes: a beach while the conversation is about trips; otherwise the chosen scene.
  // HACKATHON: a keyword check on the last reply rather than a model-picked scene.
  const travelTalk = Boolean(lastTwin && /\b(trip|travel|flight|hotel|beach|vacation|holiday|voyage|vol|plage|رحلة|سفر)\b/i.test(lastTwin.text));
  const sceneUrl = iperson?.avatarMeta?.smartScenes && travelTalk ? '/api/media/scene-beach.jpg' : iperson?.avatarMeta?.scene?.url ?? null;
  const tap = () => {
    s.act({ type: 'tap' });
    s.tap(TAP_LINES[user?.locale?.slice(0, 2) ?? 'en']?.[Math.floor(Math.random() * 3)] ?? 'Hi!');
  };


  // Push-to-talk: hold the mic while you speak and let go to send; a quick tap starts, a second tap sends.
  const pressedAt = useRef(0);
  const tapMode = useRef(false);
  const press = () => {
    if (s.listening) { tapMode.current = false; s.stopListening(); pressedAt.current = 0; return; }
    pressedAt.current = Date.now();
    void s.startListening();
  };
  const release = () => {
    if (!pressedAt.current) return;
    const held = Date.now() - pressedAt.current;
    pressedAt.current = 0;
    if (held < 350) { tapMode.current = true; return; } // a tap: keep listening until the next tap
    s.stopListening();
  };
  const status = s.listening ? (tapMode.current ? 'Listening… tap the mic to send' : 'Listening… release to send')
    : s.thinking ? 'Thinking…'
    : s.speaking ? 'Speaking: press the mic to interrupt'
    : null;

  return (
    <div
      className={`rim-glow flex flex-col items-center overflow-hidden px-4 pt-3 ${view.keyboard ? 'fixed inset-x-0 z-40 bg-ink' : 'relative'}`}
      // With the phone keyboard open, the screen is exactly the part above the keyboard, so the avatar stays in view.
      style={view.keyboard ? { top: view.top, height: view.height } : { height: 'calc(100dvh - 3.6rem - var(--beta-h, 0px))' }}
    >
      {s.demo && (
        <div className="mb-2 shrink-0 rounded-full border border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">
          Demo mode: Muse Spark key not connected yet — replies are scripted
        </div>
      )}

      <div className="relative shrink-0">
        <div className="absolute right-0 top-1 z-10"><InstallApp avatarUrl={iperson?.avatarUrl} /></div>
        <Suspense fallback={<Avatar imageUrl={iperson?.avatarUrl ?? null} mouth={iperson?.avatarMeta?.mouth} level={s.level} state={s.avatarState} size={size} />}>
          <LivingAvatar rig={rig} level={s.level} behaviour={s.behaviour} state={s.avatarState} size={size} onTap={tap} onLongPress={() => nav('/twin')} sceneUrl={sceneUrl} />
        </Suspense>
      </div>

      <div className={`mt-1 min-h-[1.5rem] w-full max-w-xl shrink-0 text-center ${view.keyboard ? 'hidden' : ''}`}>
        {s.caption ? <p className="line-clamp-2 text-white/70 italic">“{s.caption}”</p>
          : !s.lines.length && !s.thinking ? <p className="text-muted">Hold the mic and talk to {iperson?.displayName ?? 'your i-person'}.</p>
          : null}
      </div>

      {/* The conversation scrolls; the mic and the text box below never move. */}
      <div ref={log} className="mt-2 min-h-0 w-full max-w-xl flex-1 space-y-2 overflow-y-auto pb-2 text-[15px] leading-relaxed">
        {s.lines.map((l, k) => (
          <div key={k} className={l.who === 'you' ? 'flex justify-end' : 'flex justify-start'}>
            <p className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 ${l.who === 'you' ? 'rounded-br-md bg-white/10 text-white/90' : 'rounded-bl-md border border-line bg-panel/80'}`}><Linked text={l.text} /></p>
          </div>
        ))}
        {s.thinking && <p className="px-1 text-sm text-muted">{iperson?.displayName ?? 'Your i-person'} is thinking…</p>}
        {!s.lines.length && !demoPrompts && (
          <div className="flex flex-wrap justify-center gap-2 pt-2">
            {SUGGESTIONS.map((t) => (
              <button key={t} onClick={() => s.sendText(t)} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted hover:text-white">{t}</button>
            ))}
          </div>
        )}
      </div>

      <div className={`w-full max-w-xl shrink-0 border-t border-line/60 bg-ink/70 pt-3 backdrop-blur ${view.keyboard ? 'pb-2' : 'pb-[max(0.75rem,env(safe-area-inset-bottom))]'}`}>
        {/* DEMO: the scene's sentences as one-tap chips (a fallback for the mic while recording). */}
        {demoPrompts && !view.keyboard && (
          <div className="mb-2 flex flex-wrap justify-center gap-1.5">
            {demoPrompts.map((t) => (
              <button key={t} type="button" onClick={() => s.sendText(t)} disabled={s.thinking}
                className="rounded-full border border-line bg-panel/60 px-3 py-1 text-xs text-white/75 hover:border-white/40 hover:text-white disabled:opacity-40">{t}</button>
            ))}
          </div>
        )}
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); s.sendText(text); setText(''); }}>
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); press(); }}
            onPointerUp={release}
            onPointerLeave={release}
            onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(); } }}
            onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') release(); }}
            onContextMenu={(e) => e.preventDefault()}
            className={`grid h-12 w-12 shrink-0 touch-none select-none place-items-center rounded-full transition ${s.listening ? `bg-rim text-black ${s.userSpeaking ? 'pulse-ring' : ''}` : 'bg-white text-black hover:scale-105'}`}
            aria-label={s.listening ? 'Send what I said' : 'Hold to talk'}
            aria-pressed={s.listening}
          >
            {s.listening ? <MicLevel level={s.micLevel} /> : <MicIcon />}
          </button>
          <input
            value={text} onChange={(e) => setText(e.target.value)} placeholder="Type here…"
            className="min-w-0 flex-1 rounded-full border border-line bg-panel px-4 py-3 outline-none focus:border-rim/60"
          />
          <Button disabled={!text.trim()}>Send</Button>
        </form>
        <p className="mt-1.5 h-4 text-center text-xs text-muted">
          {s.error ? <span className="text-bad">{s.error}</span> : !s.connected ? 'Reconnecting…' : status ?? 'Hold the mic and talk, release to send'}
        </p>
      </div>

      <div data-cards style={{ top: 'calc(5rem + var(--beta-h, 0px))', right: 'calc(1.25rem + var(--calls-w, 0px))' }} className="pointer-events-none fixed inset-x-3 z-30 flex flex-col items-end gap-3 sm:inset-x-auto sm:w-96">
        {s.cards.map((c) => <ConfirmCard key={c.action_id} card={c} onDecide={s.decide} />)}
        {memory.items.map((m) => <PendingMemoryCard key={m.id} item={m} onDecide={memory.decide} />)}
        <FeedbackPrompt turns={s.lines.filter((l) => l.who === 'you').length} />
        {user?.account_kind !== 'demo' && s.lines.filter((l) => l.who === 'you').length >= 2 && <ChainPrompt />}
      </div>
    </div>
  );
}

/**
 * The part of the screen the user can see. Phone keyboards don't shrink the layout on iOS: they cover it
 * and scroll the page. So "keyboard open" = typing in a field on a touch screen, or a visual viewport much
 * shorter than the tallest one seen; the screen then follows the visual viewport.
 */
function useVisibleArea() {
  const tallest = useRef(0);
  const read = () => {
    const vv = window.visualViewport;
    const height = vv?.height ?? window.innerHeight;
    const el = document.activeElement;
    const typing = matchMedia('(pointer: coarse)').matches && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement);
    if (!typing) tallest.current = Math.max(tallest.current, height);
    return { height, top: vv?.offsetTop ?? 0, keyboard: typing || height < tallest.current * 0.75 };
  };
  const [area, setArea] = useState(read);
  useEffect(() => {
    const on = () => setArea(read());
    const vv = window.visualViewport;
    vv?.addEventListener('resize', on);
    vv?.addEventListener('scroll', on);
    window.addEventListener('resize', on);
    // Focus changes come before the keyboard's resize; read again once it has settled.
    const focus = () => { on(); setTimeout(on, 350); };
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', focus);
    return () => {
      vv?.removeEventListener('resize', on); vv?.removeEventListener('scroll', on); window.removeEventListener('resize', on);
      document.removeEventListener('focusin', focus); document.removeEventListener('focusout', focus);
    };
  }, []);
  return area;
}

function ConfirmCard({ card, onDecide }: { card: Card; onDecide(id: string, approve: boolean): void }) {
  const [left, setLeft] = useState(() => Math.max(0, new Date(card.expires_at).getTime() - Date.now()));
  useEffect(() => {
    if (card.state !== 'pending') return;
    const t = setInterval(() => setLeft(Math.max(0, new Date(card.expires_at).getTime() - Date.now())), 1000);
    return () => clearInterval(t);
  }, [card.expires_at, card.state]);
  const expired = card.state === 'pending' && left === 0;

  return (
    <div className="slide-in pointer-events-auto w-full rounded-2xl border border-line bg-panel/95 p-4 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <Chip tone={card.risk === 'money' ? 'warn' : 'rim'}>{card.risk === 'money' ? 'Payment' : 'Needs your yes'}</Chip>
        {card.state === 'pending' && !expired && <span className="text-xs text-muted">{countdown(left)}</span>}
      </div>
      <p className="font-medium">{card.summary}</p>
      {card.influenced_by && <p className="mt-1 text-xs text-warn">⚠ Suggested after reading {card.influenced_by}. Check it before approving.</p>}
      {card.held && <p className="mt-1 text-xs text-warn">⚠ {card.held}. Only a tap on Approve accepts it.</p>}
      {card.amount && <p className="mt-1 text-2xl font-semibold">{money(card.amount.cents, card.amount.currency)}</p>}
      {card.tool === 'paper_trade' && <p className="mt-1 text-xs text-warn">Simulation only — no real money</p>}
      <div className="mt-3">
        {card.state === 'pending' && !expired && (
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => onDecide(card.action_id, false)}>Decline</Button>
            <Button className="flex-1" onClick={() => onDecide(card.action_id, true)}>Approve</Button>
          </div>
        )}
        {card.state === 'working' && <p className="text-sm text-muted">Working on it…</p>}
        {card.state === 'done' && <p className="text-sm text-ok">Done</p>}
        {card.state === 'declined' && <p className="text-sm text-muted">Declined</p>}
        {(card.state === 'expired' || expired) && <p className="text-sm text-muted">Expired — ask again</p>}
        {card.state === 'failed' && <p className="text-sm text-bad">Failed{card.note ? `: ${card.note}` : ''}</p>}
      </div>
    </div>
  );
}

/** Web addresses in a reply show as a short tappable site name, not the full URL. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/((?:https?:\/\/|www\.)[^\s)]+)/gi);
  return <>{parts.map((p, i) => {
    if (i % 2 === 0) return p;
    const href = p.startsWith('http') ? p : `https://${p}`;
    let host = p;
    try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { /* keep as is */ }
    return <a key={i} href={href} target="_blank" rel="noreferrer noopener" className="text-rim underline">{host}</a>;
  })}</>;
}

/** Live bars inside the mic button while the user holds it to talk. */
function MicLevel({ level }: { level(): number }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const l = level();
      bars.current.forEach((b, i) => { if (b) b.style.height = `${6 + Math.min(1, l * (1.6 - Math.abs(i - 1) * 0.4)) * 16}px`; });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [level]);
  return <span className="flex items-center gap-1" aria-hidden>{[0, 1, 2].map((i) => <span key={i} ref={(el) => { bars.current[i] = el; }} className="w-1.5 rounded-full bg-black" style={{ height: 6 }} />)}</span>;
}

function MicIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

/** Time left on a card: m:ss under an hour; hours for longer ones (plan cards wait up to 48 h). */
function countdown(ms: number): string {
  if (ms >= 3_600_000) return `${Math.floor(ms / 3_600_000)} h left`;
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
}
