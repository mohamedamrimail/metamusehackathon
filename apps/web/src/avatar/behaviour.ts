// The living avatar's behaviour (A3): session events in, what to show out. Pure, so it's testable;
// the renderer calls frame(now) every animation frame.
import type { Mood } from '@ipersons/shared';

export type Pose = 'base' | 'blink' | 'smile' | 'thinking' | 'wave' | 'thumbs_up' | 'listening' | 'surprised';

export type BehaviourEvent =
  | { type: 'open'; firstVisitToday: boolean }
  | { type: 'user_speaking' }
  | { type: 'thinking' }
  | { type: 'speaking'; mood?: Mood }
  | { type: 'speech_done' }
  | { type: 'action_proposed' }
  | { type: 'action_done' }
  | { type: 'action_declined' }
  | { type: 'error' }
  | { type: 'tap' }
  | { type: 'activated' };

export interface Frame {
  pose: Pose;
  /** Where to look, -1..1 on each axis (0,0 = at the user). */
  gaze: { x: number; y: number };
  /** A small nod is wanted now (listening, declined). */
  nod: boolean;
  /** Show the little celebration effect. */
  celebrate: boolean;
}

const MOOD_POSE: Record<Mood, Pose> = { neutral: 'base', happy: 'smile', thinking: 'thinking', surprised: 'surprised', sorry: 'base' };
export const IDLE_AFTER_MS = 20_000;

/** A short-lived gesture that wins over the steady state until it ends. */
interface Gesture { pose: Pose; until: number; gaze?: { x: number; y: number }; celebrate?: boolean; nod?: boolean; then?: Pose }

export class Behaviour {
  private steady: Pose = 'base';
  private gesture: Gesture | null = null;
  private lastEvent: number;
  private listeningSince = 0;

  constructor(now: number, private random: () => number = Math.random) {
    this.lastEvent = now;
  }

  dispatch(e: BehaviourEvent, now: number): void {
    this.lastEvent = now;
    switch (e.type) {
      case 'open':
        if (e.firstVisitToday) this.gesture = { pose: 'wave', until: now + 2500 };
        break;
      case 'user_speaking':
        if (this.steady !== 'listening') this.listeningSince = now;
        this.steady = 'listening';
        break;
      case 'thinking':
        this.steady = 'thinking';
        this.gesture = null;
        break;
      case 'speaking':
        this.steady = MOOD_POSE[e.mood ?? 'neutral'];
        break;
      case 'speech_done':
        this.steady = 'base';
        break;
      case 'action_proposed':
        // Glance toward the approval card (it appears below/right), briefly.
        this.gesture = { pose: this.steady, until: now + 1200, gaze: { x: 0.8, y: 0.4 } };
        break;
      case 'action_done':
      case 'activated':
        this.gesture = { pose: 'thumbs_up', until: now + 2200, celebrate: true };
        break;
      case 'action_declined':
        this.gesture = { pose: 'base', until: now + 900, nod: true };
        break;
      case 'error':
        this.gesture = { pose: 'surprised', until: now + 1200 };
        this.steady = 'base';
        break;
      case 'tap':
        this.gesture = { pose: 'smile', until: now + 1500 };
        break;
    }
  }

  frame(now: number): Frame {
    if (this.gesture && now >= this.gesture.until) this.gesture = null;
    const g = this.gesture;
    if (g) return { pose: g.pose, gaze: g.gaze ?? { x: 0, y: 0 }, nod: Boolean(g.nod), celebrate: Boolean(g.celebrate) };

    if (this.steady === 'listening') {
      // Attentive, with a small nod every few seconds.
      const nod = (now - this.listeningSince) % 3500 < 400 && now - this.listeningSince > 1500;
      return { pose: 'listening', gaze: { x: 0, y: 0 }, nod, celebrate: false };
    }
    if (this.steady === 'thinking') return { pose: 'thinking', gaze: { x: 0.25, y: -0.6 }, nod: false, celebrate: false };

    if (now - this.lastEvent > IDLE_AFTER_MS) {
      // Idle: look around slowly; now and then a smile.
      const t = (now - this.lastEvent) / 1000;
      const gaze = { x: Math.sin(t * 0.45) * 0.7, y: Math.sin(t * 0.31) * 0.25 };
      if (this.random() < 0.0008) this.gesture = { pose: 'smile', until: now + 1600 };
      return { pose: 'base', gaze, nod: false, celebrate: false };
    }
    return { pose: this.steady, gaze: { x: 0, y: 0 }, nod: false, celebrate: false };
  }
}
