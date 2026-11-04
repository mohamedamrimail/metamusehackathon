import { describe, expect, it } from 'vitest';
import { splitMood } from '@ipersons/shared';
import { Behaviour, IDLE_AFTER_MS } from './behaviour.ts';

describe('avatar behaviour', () => {
  const at = (b: Behaviour, t: number) => b.frame(t).pose;

  it('waves on the first visit of the day, then rests', () => {
    const b = new Behaviour(0);
    b.dispatch({ type: 'open', firstVisitToday: true }, 0);
    expect(at(b, 100)).toBe('wave');
    expect(at(b, 3000)).toBe('base');
    const again = new Behaviour(0);
    again.dispatch({ type: 'open', firstVisitToday: false }, 0);
    expect(at(again, 100)).toBe('base');
  });

  it('listens, thinks, then speaks with the mood of the reply', () => {
    const b = new Behaviour(0);
    b.dispatch({ type: 'user_speaking' }, 0);
    expect(at(b, 10)).toBe('listening');
    b.dispatch({ type: 'thinking' }, 100);
    expect(b.frame(110)).toMatchObject({ pose: 'thinking', gaze: { y: -0.6 } });
    b.dispatch({ type: 'speaking', mood: 'happy' }, 200);
    expect(at(b, 210)).toBe('smile');
    b.dispatch({ type: 'speaking', mood: 'surprised' }, 300);
    expect(at(b, 310)).toBe('surprised');
    b.dispatch({ type: 'speech_done' }, 400);
    expect(at(b, 410)).toBe('base');
  });

  it('nods now and then while listening', () => {
    const b = new Behaviour(0);
    b.dispatch({ type: 'user_speaking' }, 0);
    const nods = Array.from({ length: 80 }, (_, i) => b.frame(i * 100).nod).filter(Boolean).length;
    expect(nods).toBeGreaterThan(0);
    expect(nods).toBeLessThan(20);
  });

  it('glances at a proposal, celebrates when it is done, nods when declined', () => {
    const b = new Behaviour(0);
    b.dispatch({ type: 'action_proposed' }, 0);
    expect(b.frame(10).gaze.x).toBeGreaterThan(0.5);
    expect(b.frame(1500).gaze.x).toBe(0);
    b.dispatch({ type: 'action_done' }, 2000);
    expect(b.frame(2010)).toMatchObject({ pose: 'thumbs_up', celebrate: true });
    b.dispatch({ type: 'action_declined' }, 5000);
    expect(b.frame(5010)).toMatchObject({ pose: 'base', nod: true });
  });

  it('looks surprised on errors, then calms down', () => {
    const b = new Behaviour(0);
    b.dispatch({ type: 'error' }, 0);
    expect(at(b, 10)).toBe('surprised');
    expect(at(b, 2000)).toBe('base');
  });

  it('looks around when idle', () => {
    const b = new Behaviour(0, () => 1);
    const gx = [0, 1, 2, 3].map((i) => b.frame(IDLE_AFTER_MS + 1000 + i * 1500).gaze.x);
    expect(new Set(gx.map((x) => x.toFixed(2))).size).toBeGreaterThan(1);
  });

  it('smiles when tapped', () => {
    const b = new Behaviour(0);
    b.dispatch({ type: 'tap' }, 0);
    expect(at(b, 10)).toBe('smile');
  });
});

describe('mood tags', () => {
  it('extracts the mood and never leaves the tag in the text', () => {
    expect(splitMood('[mood:happy] Done! See you Sunday.')).toEqual({ mood: 'happy', text: 'Done! See you Sunday.' });
    expect(splitMood('Hmm. [mood: Thinking]')).toEqual({ mood: 'thinking', text: 'Hmm.' });
    expect(splitMood('No tag here.')).toEqual({ mood: undefined, text: 'No tag here.' });
  });
});
