import type { ServerEvent } from '@ipersons/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { voiceLatency } from '../src/db/schema.ts';
import { buildApp, createDeps } from '../src/index.ts';
import {
  latencyRow, latencySummary, markModelResponse, percentile, recordVoiceLatency, summarizeLatency, VoiceTurnClock, withVoiceClock,
  type LatencyRow,
} from '../src/lib/latency.ts';
import { DemoLlm } from '../src/meta/demo-llm.ts';
import type { SttFactory } from '../src/meta/stt.ts';
import { makeIperson, reset, testDb, testGeo } from './helpers.ts';

// Voice latency (jury prompt §8): per-turn stage timings, their storage and the admin p50/p90.

const { db, pool } = testDb();
let app: FastifyInstance | undefined;

beforeEach(async () => {
  await reset(db);
  await db.execute('truncate voice_latency');
  await app?.close();
  app = undefined;
});
afterAll(async () => {
  await app?.close();
  await pool.end();
});

/** A clock whose "now" the test sets. */
function fakeClock() {
  let t = 0;
  const clock = new VoiceTurnClock(() => t);
  return { clock, at: (ms: number) => { t = ms; } };
}

describe('percentiles', () => {
  it('interpolates between closest ranks, like percentile_cont', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([700], 0.9)).toBe(700);
    expect(percentile([400, 100, 300, 200], 0.5)).toBe(250);
    expect(percentile([100, 200, 300, 400], 0.9)).toBe(370);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9); // 9.1 rounded
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 1)).toBe(5);
  });
});

describe('voice turn clock', () => {
  it('turns stage marks into stage durations; each stage keeps its first mark', () => {
    const { clock, at } = fakeClock();
    at(1000); clock.mark('speechEnd');
    at(1300); clock.mark('transcript');
    at(2100); clock.mark('firstModel');
    at(2500); clock.mark('firstModel'); // a later model call in the same turn doesn't count
    at(3200); clock.mark('reply');
    at(3550); clock.mark('firstAudio');
    expect(latencyRow(clock)).toEqual({ sttMs: 300, firstModelMs: 800, replyMs: 1900, ttsMs: 350, totalMs: 2550, ttsMode: 'server' });
  });

  it('leaves stages that were not reached empty and says how the reply was voiced', () => {
    const { clock, at } = fakeClock();
    at(0); clock.mark('speechEnd');
    at(400); clock.mark('transcript');
    at(900); clock.mark('reply');
    clock.ttsMode = 'fallback';
    expect(latencyRow(clock)).toEqual({ sttMs: 400, firstModelMs: null, replyMs: 500, ttsMs: null, totalMs: null, ttsMode: 'fallback' });
    expect(latencyRow(new VoiceTurnClock()).ttsMode).toBe('none');
  });

  it('lets the runtime mark the first model response of the voice turn in scope (and nothing outside one)', async () => {
    const { clock, at } = fakeClock();
    markModelResponse(); // no voice turn: no-op
    at(50);
    await withVoiceClock(clock, async () => {
      await new Promise((r) => setTimeout(r, 1));
      markModelResponse();
      at(90);
      markModelResponse();
    });
    expect(clock.at.firstModel).toBe(50);
  });

  it('summarizes p50/p90 per stage, skipping empty stages', () => {
    const row = (total: number | null, ttsMode: LatencyRow['ttsMode'] = 'server'): LatencyRow =>
      ({ sttMs: 300, firstModelMs: 900, replyMs: 1200, ttsMs: total === null ? null : 400, totalMs: total, ttsMode });
    const s = summarizeLatency([row(1800), row(2000), row(2600), row(null, 'fallback')], 7);
    expect(s.turns).toBe(4);
    expect(s.tts_modes).toEqual({ server: 3, fallback: 1 });
    expect(s.stages.find((x) => x.key === 'totalMs')).toMatchObject({ n: 3, p50: 2000, p90: 2480 });
    expect(s.stages.find((x) => x.key === 'sttMs')).toMatchObject({ n: 4, p50: 300, p90: 300 });
  });
});

describe('storage and admin summary', () => {
  it('records a voice turn once, and skips turns that never got a transcript', async () => {
    const { iperson } = await makeIperson(db);
    const { clock, at } = fakeClock();
    at(0); clock.mark('speechEnd');
    expect(await recordVoiceLatency(db, iperson.id, clock)).toBeNull(); // no transcript (silence)
    at(250); clock.mark('transcript');
    at(1250); clock.mark('reply');
    at(1500); clock.mark('firstAudio');
    expect(await recordVoiceLatency(db, iperson.id, clock)).toMatchObject({ totalMs: 1500 });
    expect(await recordVoiceLatency(db, iperson.id, clock)).toBeNull(); // only once
    const rows = await db.select().from(voiceLatency);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ipersonId: iperson.id, sttMs: 250, replyMs: 1000, ttsMs: 250, totalMs: 1500, firstModelMs: null, ttsMode: 'server' });
    const summary = await latencySummary(db, 7);
    expect(summary.stages.find((x) => x.key === 'totalMs')).toMatchObject({ n: 1, p50: 1500, p90: 1500 });
  });

  it('serves p50/p90 to admins only', async () => {
    app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(), stt: undefined, demoMode: true }));
    const cookie = async (email: string) => {
      const r = await app!.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'correct horse', name: 'X' } });
      return String(r.headers['set-cookie']).split(';')[0]!;
    };
    await db.insert(voiceLatency).values([1000, 2000, 3000].map((totalMs) => ({ sttMs: 300, replyMs: 500, ttsMs: 200, totalMs, ttsMode: 'server' })));
    const user = await cookie('someone@example.com');
    expect((await app.inject({ url: '/api/admin/metrics/latency', headers: { cookie: user } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/admin/metrics/latency' })).statusCode).toBe(401);
    const res = await app.inject({ url: '/api/admin/metrics/latency?days=1', headers: { cookie: await cookie('admin@example.com') } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: number; turns: number; stages: { key: string; p50: number; p90: number; n: number }[] };
    expect(body).toMatchObject({ days: 1, turns: 3 });
    expect(body.stages.find((x) => x.key === 'totalMs')).toMatchObject({ n: 3, p50: 2000, p90: 2800 });
    expect(body.stages.find((x) => x.key === 'firstModelMs')).toMatchObject({ n: 0, p50: null });
  });
});

describe('voice session', () => {
  it('records every stage of a real voice turn: commit → transcript → model → reply → browser voice', async () => {
    // Fake STT: the final transcript arrives 30 ms after the end of speech.
    const frames: Buffer[] = [];
    const stt: SttFactory = (_opts, h) => ({
      write: (pcm) => frames.push(pcm),
      commit: () => void setTimeout(() => h.onFinal('Book yoga on Tuesday 6pm'), 30),
      close: () => {},
    });
    app = buildApp(createDeps(db, { geo: testGeo, llm: new DemoLlm(() => new Date('2026-11-02T09:00:00Z')), stt, demoMode: true, billing: false }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'merry@example.com', password: 'correct horse', name: 'Merry' } });
    const cookie = String(reg.headers['set-cookie']).split(';')[0]!;
    const ipersonId = (await app.inject({ method: 'POST', url: '/api/ipersons', headers: { cookie }, payload: { display_name: 'Mimi', locale: 'en', timezone: 'Africa/Tunis' } })).json().iperson.id as string;

    const port = (app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/session?iperson=${ipersonId}`, { headers: { cookie } });
    const events: string[] = [];
    const ended = new Promise<void>((resolve) => ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const e = JSON.parse(String(data)) as ServerEvent;
      events.push(e.type);
      if (e.type === 'speak') resolve();
    }));
    await new Promise((r) => ws.on('open', r));
    ws.send(Buffer.alloc(640));
    ws.send(Buffer.alloc(640));
    ws.send(JSON.stringify({ type: 'audio.commit' }));
    await ended;
    ws.close();

    expect(frames).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining(['stt.final', 'agent.text', 'action.proposed', 'speak']));
    const [row] = await vi.waitFor(async () => {
      const rows = await db.select().from(voiceLatency);
      expect(rows).toHaveLength(1);
      return rows;
    });
    expect(row).toMatchObject({ ipersonId, ttsMode: 'browser' });
    expect(row!.sttMs).toBeGreaterThanOrEqual(25);
    expect(row!.ttsMs).toBeGreaterThanOrEqual(0);
    for (const k of ['firstModelMs', 'replyMs', 'totalMs'] as const) expect(row![k]).not.toBeNull();
    expect(row!.firstModelMs!).toBeLessThanOrEqual(row!.replyMs!);
    expect(row!.totalMs!).toBeGreaterThanOrEqual(row!.sttMs! + row!.replyMs! + row!.ttsMs! - 2);

    // Typed turns are not voice turns: no row.
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/session?iperson=${ipersonId}`, { headers: { cookie } });
    const done2 = new Promise<void>((resolve) => ws2.on('message', (data, isBinary) => {
      if (!isBinary && (JSON.parse(String(data)) as ServerEvent).type === 'speak') resolve();
    }));
    await new Promise((r) => ws2.on('open', r));
    ws2.send(JSON.stringify({ type: 'text.input', text: 'hello' }));
    await done2;
    ws2.close();
    expect(await db.select().from(voiceLatency)).toHaveLength(1);
  });
});
