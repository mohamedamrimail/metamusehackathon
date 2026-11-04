import type { ClientEvent, ServerEvent } from '@ipersons/shared';
import { TAP_LINES, speakable } from '@ipersons/shared';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { actions, users } from '../db/schema.ts';
import { ownIperson, SESSION_COOKIE } from '../http/auth.ts';
import type { AppDeps } from '../http/deps.ts';
import { charge, hasCredit } from '../billing/credits.ts';
import type { SttStream } from '../meta/stt.ts';
import { config } from '../config.ts';
import { isPending } from '../lib/approval.ts';
import { runtimeSettings } from '../lib/settings.ts';
import { recordVoiceLatency, VoiceTurnClock, withVoiceClock } from '../lib/latency.ts';
import { proposedEvent, publishTurn } from './events.ts';
import { clip, logCall } from '../lib/call-log.ts';

const ClientMsg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text.input'), text: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal('audio.commit') }),
  z.object({ type: z.literal('audio.interrupt') }),
  z.object({ type: z.literal('avatar.tap') }),
]) satisfies z.ZodType<ClientEvent>;

/**
 * Only one open Talk screen per twin speaks: the one used last (opened, typed or talked in). Others still
 * get the text, silently. Two screens (a phone tab and the home-screen app, or a laptop) otherwise echo.
 */
const voiceOwner = new Map<string, symbol>();

/** GET /ws/session?iperson=<id> — one voice session (SPEC: WebSocket events). */
export async function webChannel(app: FastifyInstance, deps: AppDeps) {
  app.get<{ Querystring: { iperson?: string } }>('/ws/session', { websocket: true }, (socket: WebSocket, req) => {
    // Listen right away: messages that arrive while the session is still loading would otherwise be lost.
    const early: [Buffer, boolean][] = [];
    const buffer = (data: Buffer, isBinary: boolean) => early.push([data, isBinary]);
    socket.on('message', buffer);
    session(socket, req, () => {
      socket.off('message', buffer);
      return early;
    }).catch((err) => {
      req.log.error({ err }, 'ws session failed');
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'error', code: 'internal', message: 'Session failed.' } satisfies ServerEvent));
        socket.close(1011, 'internal');
      }
    });
  });

  async function session(
    socket: WebSocket, req: FastifyRequest<{ Querystring: { iperson?: string } }>, takeEarly: () => [Buffer, boolean][],
  ) {
    const send = (e: ServerEvent) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(e));
    const fail = (code: string, message: string) => {
      send({ type: 'error', code, message });
      socket.close(4001, code);
    };

    try {
      req.user = app.jwt.verify(req.cookies[SESSION_COOKIE] ?? '');
    } catch {
      return fail('not_signed_in', 'Sign in first.');
    }
    if (await isPending(deps.db, req.user.sub)) return fail('pending_approval', 'Your account is waiting for approval.');
    const ip = await ownIperson(deps, req, req.query.iperson ?? '');
    if (!ip) return fail('not_found', 'No such i-person.');
    const [user] = await deps.db.select().from(users).where(eq(users.id, ip.userId));
    const conversationId = await deps.runtime.conversationFor(ip.id, 'web');

    // Speech: the browser speaks every final reply with its own speechSynthesis (no model call). Only one open
    // Talk screen per twin speaks (voiceOwner): the server sends `speak` to that session alone.
    const me = Symbol('session');
    const claimVoice = () => voiceOwner.set(ip.id, me);
    claimVoice();
    // Voice latency: a voice turn's clock ends when its reply is handed to the browser voice (lib/latency.ts).
    const recordLatency = (clock: VoiceTurnClock) => void recordVoiceLatency(deps.db, ip.id, clock).catch((err) => req.log.warn({ err }, 'latency record failed'));
    let replyClock: VoiceTurnClock | undefined;
    const speak = (reply: string, opts: { clock?: VoiceTurnClock } = {}) => {
      const clock = opts.clock;
      if (clock) { clock.claimed = true; clock.ttsMode = 'browser'; }
      if (voiceOwner.get(ip.id) === me) send({ type: 'speak', text: speakable(reply) }); // never read out web addresses
      clock?.mark('firstAudio');
      if (clock) recordLatency(clock);
    };

    const unsubscribe = deps.bus.subscribe(ip.id, (e) => {
      send(e);
      if (e.type === 'agent.text' && e.final) speak(e.text, { clock: replyClock });
    });

    // One turn at a time per session; later utterances wait their turn.
    let queue: Promise<unknown> = Promise.resolve();
    const turn = (text: string, clock?: VoiceTurnClock) => {
      queue = queue.then(async () => {
        deps.bus.publish(ip.id, { type: 'agent.thinking' });
        try {
          const run = () => deps.runtime.handleUserMessage({ ipersonId: ip.id, conversationId, text });
          const res = clock ? await withVoiceClock(clock, run) : await run();
          clock?.mark('reply');
          // The reply's speech (started synchronously by the bus listener above) takes this turn's clock.
          replyClock = clock;
          publishTurn(deps.bus, ip.id, res);
          replyClock = undefined;
          await refreshCredit();
        } catch (err) {
          req.log.error({ err }, 'agent turn failed');
          send({ type: 'error', code: 'agent_failed', message: 'I had trouble thinking about that. Try again?' });
        } finally {
          if (clock && !clock.claimed) recordLatency(clock); // nothing spoken (no reply, or the turn failed)
        }
      });
    };

    // AI credit gate for the mic (the agent turn checks its own). Refreshed after every charge.
    let creditOk = true;
    const refreshCredit = async () => { if (deps.billing) creditOk = await hasCredit(deps.db, ip.userId); };
    await refreshCredit();

    let stt: SttStream | undefined;
    let refusedMic = false;
    const sttStream = () => {
      if (stt || !deps.stt) return stt;
      if (!creditOk) {
        if (!refusedMic) send({ type: 'error', code: 'no_credit', message: 'Your AI credit is used up. Top up on the My twin page.' });
        refusedMic = true;
        return undefined;
      }
      // Charged per second of audio streamed: PCM16 mono 16 kHz = 32 000 bytes/s.
      let bytes = 0;
      let charged = false;
      const bill = () => {
        if (charged || !deps.billing || bytes === 0) return;
        charged = true;
        void charge(deps.db, ip.userId, { kind: 'stt', model: 'muse-voice-transcribe-1.0', seconds: bytes / 32_000 })
          .then(refreshCredit)
          .catch((err) => req.log.error({ err }, 'stt charge failed'));
      };
      // One stream = one utterance = one voice turn: its clock starts at the end of speech (audio.commit).
      const clock = new VoiceTurnClock();
      const s: SttStream = deps.stt({ language: user?.locale ?? 'en' }, {
        onPartial: (text) => send({ type: 'stt.partial', text }),
        onFinal: (text) => {
          bill();
          clock.mark('transcript');
          // DEMO: Meta AI calls panel — end of speech → final transcript.
          void logCall({ service: 'Muse Voice Transcribe', what: `live transcript "${clip(text, 70)}"`, ms: clock.at.speechEnd && clock.at.transcript ? Math.round(clock.at.transcript - clock.at.speechEnd) : undefined }, { userId: ip.userId });
          send({ type: 'stt.final', text });
          if (text.trim()) turn(text, clock);
        },
        onError: (err) => {
          bill();
          req.log.warn({ err }, 'stt failed');
          send({ type: 'error', code: 'stt_failed', message: 'Speech recognition failed; type instead.' });
          s.close();
          if (stt === s) stt = undefined;
        },
      });
      stt = {
        write: (pcm) => { bytes += pcm.length; s.write(pcm); },
        commit: () => { clock.mark('speechEnd'); s.commit(); },
        close: () => { bill(); s.close(); },
      };
      return stt;
    };

    send({ type: 'session.ready', stt: deps.stt ? 'server' : 'browser', demo: deps.demoMode });
    // Cards still waiting for a yes reappear when Talk is (re)opened.
    const waiting = await deps.db.select().from(actions)
      .where(and(eq(actions.ipersonId, ip.id), eq(actions.status, 'proposed'), gt(actions.expiresAt, new Date()))).orderBy(asc(actions.createdAt));
    for (const a of waiting) send(proposedEvent(a));

    let lastTap = 0;
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        claimVoice();
        sttStream()?.write(data as Buffer);
        return;
      }
      let msg: z.infer<typeof ClientMsg>;
      try {
        msg = ClientMsg.parse(JSON.parse(String(data)));
      } catch {
        return send({ type: 'error', code: 'bad_message', message: 'Unrecognized message.' });
      }
      claimVoice(); // whoever the user is using now gets the voice
      if (msg.type === 'avatar.tap') {
        const lines = TAP_LINES[(user?.locale ?? 'en').slice(0, 2)] ?? TAP_LINES.en!;
        if (Date.now() - lastTap > 1500) speak(lines[Math.floor(Math.random() * lines.length)]!);
        lastTap = Date.now();
      }
      else if (msg.type === 'text.input') { refusedMic = false; turn(msg.text); }
      else if (msg.type === 'audio.commit') {
        // The stream finishes on its own (final transcript, then close); the next press opens a new one.
        stt?.commit();
        stt = undefined;
        refusedMic = false;
      }
      // audio.interrupt: the browser stops its own speech; nothing to cancel here.
    };
    socket.on('message', onMessage);
    for (const [data, isBinary] of takeEarly()) onMessage(data, isBinary);

    socket.on('close', () => {
      if (voiceOwner.get(ip.id) === me) voiceOwner.delete(ip.id);
      unsubscribe();
      stt?.close();
    });
  }
}
