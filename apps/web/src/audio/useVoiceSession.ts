import type { ActionProposed, ClientEvent, PendingMemoryItem, ServerEvent } from '@ipersons/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { AvatarState } from '../avatar/Avatar.tsx';
import { Behaviour, type BehaviourEvent } from '../avatar/behaviour.ts';
import { browserSttSupported, listen } from './browser-stt.ts';
import { startMic, type Mic } from './mic.ts';
import { Speaker } from './speaker.ts';

export interface Line { who: 'you' | 'twin' | 'system'; text: string }
export interface Card extends ActionProposed { state: 'pending' | 'working' | 'done' | 'failed' | 'declined' | 'expired'; note?: string }

type Ready = Extract<ServerEvent, { type: 'session.ready' }>;

/** One live conversation with the i-person over /ws/session. */
export function useVoiceSession(ipersonId: string | undefined, locale: string) {
  const speaker = useMemo(() => new Speaker(), []);
  const ws = useRef<WebSocket | null>(null);
  const ready = useRef<Ready | null>(null);
  const [connected, setConnected] = useState(false);
  const [demo, setDemo] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [caption, setCaption] = useState('');
  const [thinking, setThinking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  /** Facts/rules held after outside content, as they arrive in this session. */
  const [heldMemory, setHeldMemory] = useState<PendingMemoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Push-to-talk: the mic is open only while the user holds the button (or between two taps). */
  const mic = useRef<Mic | null>(null);
  const browserRec = useRef<{ stop(): void; abort(): void } | null>(null);
  /** The press is still starting (permission prompt, audio setup) when the user lets go: stop right after. */
  const starting = useRef<Promise<void> | null>(null);
  const stopAfterStart = useRef(false);
  const [userSpeaking, setUserSpeaking] = useState(false);

  // The living avatar's behaviour, fed by the same events (A3).
  const behaviour = useMemo(() => new Behaviour(performance.now()), []);
  const act = useCallback((e: BehaviourEvent) => behaviour.dispatch(e, performance.now()), [behaviour]);
  speaker.onSpeakingChange = (on: boolean) => {
    setSpeaking(on);
    if (!on) act({ type: 'speech_done' });
  };
  const push = (l: Line) => setLines((prev) => [...prev.slice(-40), l]);

  const send = useCallback((e: ClientEvent) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(e));
  }, []);

  useEffect(() => {
    if (!ipersonId) return;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;

    api<{ messages: { role: string; content: string }[] }>(`/ipersons/${ipersonId}/messages`)
      .then((r) => setLines(r.messages.map((m) => ({ who: m.role === 'user' ? 'you' : 'twin', text: m.content }))))
      .catch(() => {});

    const connect = () => {
      const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/session?iperson=${ipersonId}`);
      sock.binaryType = 'arraybuffer';
      ws.current = sock;
      sock.onopen = () => {
        retry = 0;
        setConnected(true);
        setError(null);
        act({ type: 'open', firstVisitToday: firstVisitToday() });
      };
      sock.onclose = () => {
        setConnected(false);
        if (!closed) timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15_000));
      };
      sock.onmessage = (m) => {
        if (m.data instanceof ArrayBuffer) return; // the server sends no audio: the browser speaks
        const e = JSON.parse(m.data as string) as ServerEvent;
        switch (e.type) {
          case 'session.ready': ready.current = e; setDemo(e.demo); break;
          case 'stt.partial': setCaption(e.text); act({ type: 'user_speaking' }); break;
          case 'stt.final': setCaption(''); if (e.text.trim()) push({ who: 'you', text: e.text }); break;
          case 'agent.thinking': setThinking(true); act({ type: 'thinking' }); break;
          case 'agent.text':
            if (!e.final) break;
            setThinking(false);
            act({ type: 'speaking', mood: e.mood });
            push({ who: 'twin', text: e.text });
            break;
          case 'speak': speaker.speakText(e.text, locale); break;
          case 'action.proposed': act({ type: 'action_proposed' }); setCards((c) => [...c.filter((x) => x.action_id !== e.action_id), { ...e, state: 'pending' }]); break;
          case 'action.updated':
            if (e.status === 'done') act({ type: 'action_done' });
            else if (e.status === 'rejected') act({ type: 'action_declined' });
            setCards((c) => c.map((x) => x.action_id !== e.action_id ? x : {
              ...x,
              state: e.status === 'done' ? 'done' : e.status === 'failed' ? 'failed' : e.status === 'rejected' ? 'declined' : e.status === 'expired' ? 'expired' : x.state,
              note: e.status === 'failed' ? String((e.result as { error?: string } | undefined)?.error ?? '') : undefined,
            }));
            break;
          case 'memory.pending': setHeldMemory(e.items); break;
          case 'service.activated':
            act({ type: 'activated' });
            push({ who: 'twin', text: e.line });
            speaker.speakText(e.line, locale);
            break;
          case 'error': setThinking(false); setError(e.message); act({ type: 'error' }); break;
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws.current?.close();
      speaker.stop();
    };
  }, [ipersonId, locale, speaker, act]);

  // Finished cards fade out after a few seconds.
  useEffect(() => {
    if (!cards.some((c) => c.state !== 'pending' && c.state !== 'working')) return;
    const t = setTimeout(() => setCards((c) => c.filter((x) => x.state === 'pending' || x.state === 'working')), 6000);
    return () => clearTimeout(t);
  }, [cards]);

  const sendText = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    speaker.unlock();
    if (speaker.speaking) { speaker.stop(); send({ type: 'audio.interrupt' }); }
    push({ who: 'you', text: t });
    send({ type: 'text.input', text: t });
  }, [send, speaker]);

  /** Press: open the mic and stream (Muse Voice Transcribe), or start browser recognition in demo mode. */
  const startListening = useCallback(async () => {
    if (mic.current || browserRec.current || starting.current) return;
    speaker.unlock();
    setError(null);
    // Talking over the twin interrupts it, like a person would.
    if (speaker.speaking) { speaker.stop(); send({ type: 'audio.interrupt' }); }
    stopAfterStart.current = false;
    const run = (async () => {
      if (ready.current?.stt === 'server') {
        mic.current = await startMic((pcm) => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(pcm); });
      } else if (browserSttSupported) {
        browserRec.current = listen(locale, {
          onPartial: (t) => setCaption(t),
          onFinal: (t) => { setCaption(''); sendText(t); },
          onEnd: () => { browserRec.current = null; setListening(false); setUserSpeaking(false); },
          onError: (e) => { if (e === 'not-allowed') setError('Microphone permission denied.'); },
        });
      } else {
        throw new Error('Voice input is not supported in this browser yet; type instead.');
      }
      setListening(true);
      setUserSpeaking(true);
      act({ type: 'user_speaking' });
    })();
    starting.current = run;
    try {
      await run;
    } catch (err) {
      setError(err instanceof Error && err.name === 'NotAllowedError' ? 'Microphone permission denied.' : err instanceof Error ? err.message : 'Microphone unavailable');
    } finally {
      starting.current = null;
    }
    if (stopAfterStart.current) stopListening();
  }, [locale, send, sendText, speaker, act]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Release: send what was said (audio.commit → final transcript → the twin answers). */
  const stopListening = useCallback(() => {
    if (starting.current) { stopAfterStart.current = true; return; }
    if (mic.current) {
      send({ type: 'audio.commit' });
      mic.current.stop();
      mic.current = null;
    }
    browserRec.current?.stop();
    setListening(false);
    setUserSpeaking(false);
  }, [send]);

  useEffect(() => () => { mic.current?.stop(); browserRec.current?.abort(); }, []);

  const decide = useCallback(async (actionId: string, approve: boolean) => {
    speaker.unlock();
    setCards((c) => c.map((x) => x.action_id === actionId ? { ...x, state: 'working' } : x));
    try {
      await api(`/actions/${actionId}/${approve ? 'confirm' : 'reject'}`, { method: 'POST' });
      if (!approve) setCards((c) => c.map((x) => x.action_id === actionId ? { ...x, state: 'declined' } : x));
    } catch (err) {
      const note = err instanceof ApiError && err.code === 'expired' ? 'Expired — ask again.' : err instanceof Error ? err.message : 'failed';
      setCards((c) => c.map((x) => x.action_id === actionId ? { ...x, state: err instanceof ApiError && err.code === 'expired' ? 'expired' : 'failed', note } : x));
    }
  }, [speaker]);

  const avatarState: AvatarState = speaking ? 'speaking' : thinking ? 'thinking' : listening ? 'listening' : 'idle';
  const level = useCallback(() => speaker.level(), [speaker]);
  /** Tapping the avatar: the server picks a short line and sends it back to speak; offline, a local line. */
  const tap = useCallback((fallbackLine: string) => {
    speaker.unlock();
    if (speaker.speaking) return;
    if (ws.current?.readyState === WebSocket.OPEN) send({ type: 'avatar.tap' });
    else speaker.speakText(fallbackLine, locale);
  }, [speaker, send, locale]);
  const micLevel = useCallback(() => mic.current?.level() ?? 0, []);

  const behaviourFrame = useCallback(() => behaviour.frame(performance.now()), [behaviour]);
  return { behaviour: behaviourFrame, act, speaker, tap, heldMemory, connected, demo, lines, caption, thinking, listening, userSpeaking, speaking, micLevel, cards, error, avatarState, level, sendText, startListening, stopListening, decide, unlock: () => speaker.unlock() };
}

/** True once per calendar day (the avatar waves). Storage may be unavailable: then always true. */
function firstVisitToday(): boolean {
  try {
    const today = new Date().toDateString();
    if (localStorage.getItem('ip_last_visit') === today) return false;
    localStorage.setItem('ip_last_visit', today);
  } catch { /* private mode */ }
  return true;
}
