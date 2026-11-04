import type { Mood } from './mood.ts';
// WebSocket /ws/session event types, shared by server and web (SPEC: API endpoints and WebSocket events).
// Audio travels as binary frames, client → server only: raw PCM16 16 kHz mono. Speech output is the
// browser's own speechSynthesis (no model call), triggered by the `speak` event.

export type Risk = 'read' | 'write' | 'money';

export type ActionStatus = 'proposed' | 'confirmed' | 'rejected' | 'expired' | 'done' | 'failed';

export type Channel = 'web' | 'whatsapp';

export type ClientEvent =
  | { type: 'text.input'; text: string }
  /** Push-to-talk released: finalize the current utterance. */
  | { type: 'audio.commit' }
  | { type: 'audio.interrupt' }
  /** The user tapped the avatar: it says a short line in its own voice. */
  | { type: 'avatar.tap' };

export interface ActionProposed {
  type: 'action.proposed';
  action_id: string;
  tool: string;
  summary: string;
  risk: Risk;
  amount?: { cents: number; currency: string };
  expires_at: string;
  /** Proposed after reading untrusted content: "Suggested after reading <source>." */
  influenced_by?: string;
  /** The rules check couldn't run: shown as a warning, and only an explicit tap approves it. */
  held?: string;
}

export type ServerEvent =
  /** First event on connect: who transcribes (Muse Voice Transcribe on the server, or the browser). */
  | { type: 'session.ready'; stt: 'server' | 'browser'; demo: boolean }
  | { type: 'stt.partial'; text: string }
  | { type: 'stt.final'; text: string }
  | { type: 'agent.thinking' }
  | { type: 'agent.text'; text: string; final: boolean; mood?: Mood }
  /** Say this aloud with the browser's speechSynthesis (sent only to the Talk screen that owns the voice). */
  | { type: 'speak'; text: string }
  /** A Service Store activation: the avatar gives a thumbs up and says what it can now do. */
  | { type: 'service.activated'; name: string; line: string }
  /** Facts or rules the twin learned right after reading outside content: shown with Keep / Discard. */
  | { type: 'memory.pending'; items: PendingMemoryItem[] }
  | ActionProposed
  | { type: 'action.updated'; action_id: string; status: ActionStatus; result?: unknown }
  | { type: 'error'; code: string; message: string };

/** A fact or rule held until the user keeps it (learned after reading web, email or other outside content). */
export interface PendingMemoryItem { kind: 'fact' | 'rule'; id: string; text: string; source: string }
