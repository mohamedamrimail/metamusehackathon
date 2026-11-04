import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { splitMood } from '@ipersons/shared';
import { ActionError } from '../agent/runtime.ts';
import { hasCredit } from '../billing/credits.ts';
import { publishDecision, publishTurn } from '../channels/events.ts';
import { config } from '../config.ts';
import { conversations, glassesDevices, ipersons, messages, users } from '../db/schema.ts';
import { isPending } from '../lib/approval.ts';
import { HOUR, limited } from '../lib/ratelimit.ts';
import { avatarRig } from '../lib/rig.ts';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

// Meta Ray-Ban Display glasses: the /glasses web app shows the twin floating in view, its replies and the approval
// cards (Neural Band taps), and sends typed or dictated requests. Web Apps on the glasses have no microphone, camera or
// documented cookies, so a paired device token (Bearer) works on /glasses/* only, and the page polls with fetch.

const MAX_DEVICES = 3;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const run = promisify(execFile);

export const installLink = (token: string) =>
  `fb-viewapp://web_app_deep_link?appName=${encodeURIComponent('i-persons')}&appUrl=${encodeURIComponent(`${config.PUBLIC_URL}/glasses?k=${token}`)}`;

export async function glassesRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  // --- pairing, from the signed-in web app (My twin → Glasses) ---
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);
    scope.get('/me/glasses', async (req) => ({
      devices: (await db.select().from(glassesDevices).where(and(eq(glassesDevices.userId, req.user.sub), isNull(glassesDevices.revokedAt))).orderBy(desc(glassesDevices.createdAt)))
        .map((d) => ({ id: d.id, label: d.label, created_at: d.createdAt, last_seen_at: d.lastSeenAt })),
    }));
    scope.post('/me/glasses', async (req, reply) => {
      const [{ n }] = await db.select({ n: count() }).from(glassesDevices).where(and(eq(glassesDevices.userId, req.user.sub), isNull(glassesDevices.revokedAt))) as [{ n: number }];
      if (n >= MAX_DEVICES) return reply.code(409).send({ error: 'too_many', message: `Up to ${MAX_DEVICES} glasses. Remove one first.` });
      const label = z.object({ label: z.string().trim().min(1).max(40).optional() }).safeParse(req.body ?? {});
      const token = randomBytes(32).toString('base64url');
      const [d] = await db.insert(glassesDevices).values({ userId: req.user.sub, tokenHash: hash(token), label: (label.success && label.data.label) || 'Ray-Ban Display' }).returning();
      return reply.code(201).send({ id: d!.id, install_link: installLink(token), url: `${config.PUBLIC_URL}/glasses?k=${token}` });
    });
    scope.delete<{ Params: { id: string } }>('/me/glasses/:id', async (req, reply) => {
      if (!z.uuid().safeParse(req.params.id).success) return reply.code(404).send({ error: 'not_found' });
      const [d] = await db.update(glassesDevices).set({ revokedAt: new Date() })
        .where(and(eq(glassesDevices.id, req.params.id), eq(glassesDevices.userId, req.user.sub), isNull(glassesDevices.revokedAt))).returning();
      return d ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    });
  });

  // --- the glasses themselves (device token) ---
  const owner = new WeakMap<FastifyRequest, { userId: string; ip: typeof ipersons.$inferSelect }>();
  app.register(async (scope) => {
    scope.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) return reply.code(401).send({ error: 'not_paired', message: 'Pair your glasses from My twin → Glasses.' });
      const [d] = await db.select().from(glassesDevices).where(and(eq(glassesDevices.tokenHash, hash(token)), isNull(glassesDevices.revokedAt)));
      if (!d) return reply.code(401).send({ error: 'not_paired', message: 'These glasses are no longer paired.' });
      if (limited(`glasses:${d.id}`, 1200, HOUR)) return reply.code(429).send({ error: 'rate_limited' });
      const [u] = await db.select({ suspended: users.suspendedAt }).from(users).where(eq(users.id, d.userId));
      if (!u || u.suspended) return reply.code(403).send({ error: 'account_suspended' });
      if (await isPending(db, d.userId)) return reply.code(403).send({ error: 'pending_approval', message: 'Your account is waiting for approval.' });
      const [ip] = await db.select().from(ipersons).where(eq(ipersons.userId, d.userId));
      if (!ip) return reply.code(409).send({ error: 'no_twin', message: 'Create your i-person first.' });
      owner.set(req, { userId: d.userId, ip });
      if (!d.lastSeenAt || Date.now() - d.lastSeenAt.getTime() > 60_000) await db.update(glassesDevices).set({ lastSeenAt: new Date() }).where(eq(glassesDevices.id, d.id));
    });

    scope.get('/glasses/state', async (req) => {
      const { ip } = owner.get(req)!;
      const rig = await avatarRig(db, ip);
      await deps.runtime.expireStale(ip.id);
      const lines = (await db.select({ role: messages.role, content: messages.content, at: messages.createdAt }).from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(eq(conversations.ipersonId, ip.id)).orderBy(desc(messages.seq)).limit(20))
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).slice(0, 6).reverse()
        .map((m) => ({ role: m.role, text: splitMood(m.content!).text, at: m.at }));
      const cards = (await deps.runtime.pendingActions(ip.id)).map((a) => ({
        id: a.id, tool: a.tool, summary: a.summary, risk: a.risk, influenced_by: a.influencedBy ?? null, held_reason: a.heldReason ?? null, expires_at: a.expiresAt,
      }));
      return {
        twin: { name: ip.displayName, alive: rig.alive, poses: Object.keys(rig.variants).filter((v) => rig.variants[v]!.cutout_url || v === 'base') },
        lines, cards,
      };
    });

    scope.post('/glasses/say', async (req, reply) => {
      const { userId, ip } = owner.get(req)!;
      const body = z.object({ text: z.string().trim().min(1).max(1000) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid' });
      if (deps.billing && !(await hasCredit(db, userId))) return reply.code(402).send({ error: 'no_credit', message: 'Your AI credit is used up.' });
      const conversationId = await deps.runtime.conversationFor(ip.id, 'web');
      const res = await deps.runtime.handleUserMessage({ ipersonId: ip.id, conversationId, text: body.data.text });
      publishTurn(deps.bus, ip.id, res); // an open Talk tab shows it too
      return { reply: res.reply, mood: res.mood ?? null, proposed: res.proposed.length };
    });

    const decide = (approve: boolean) => async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { ip } = owner.get(req)!;
      if (!z.uuid().safeParse(req.params.id).success) return reply.code(404).send({ error: 'not_found' });
      try {
        // A tap on the glasses is an explicit approval, like a tap on the phone (held cards included, as on the web).
        const result = await deps.runtime.decide({ ipersonId: ip.id, actionId: req.params.id, approve });
        publishDecision(deps.bus, ip.id, result);
        return { status: result.action.status, reply: result.followUp?.reply ?? null };
      } catch (err) {
        if (err instanceof ActionError) return reply.code(409).send({ error: err.code, message: err.message });
        throw err;
      }
    };
    scope.post<{ Params: { id: string } }>('/glasses/actions/:id/confirm', (req, reply) => decide(true)(req, reply));
    scope.post<{ Params: { id: string } }>('/glasses/actions/:id/reject', (req, reply) => decide(false)(req, reply));

    // The twin's own pose cut-outs, scaled for the 600 × 600 display (cached next to the original).
    scope.get<{ Params: { variant: string } }>('/glasses/media/:variant', async (req, reply) => {
      const { ip } = owner.get(req)!;
      const v = (await avatarRig(db, ip)).variants[req.params.variant];
      const url = v?.cutout_url ?? (req.params.variant === 'base' ? v?.url : undefined);
      const file = url?.replace(/^\/api\/media\//, '');
      if (!file || !/^[\w-]+\.(jpg|png|webp)$/.test(file) || !(file.startsWith(`${ip.id}-`) || file.startsWith('library-'))) return reply.code(404).send({ error: 'not_found' });
      const src = join(config.UPLOAD_DIR, file);
      const small = src.replace(/\.(jpg|png|webp)$/, '-g480.$1');
      if (!(await stat(small).catch(() => null))) {
        if (!(await stat(src).catch(() => null))) return reply.code(404).send({ error: 'not_found' });
        await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', 'scale=480:-2', small]).catch(() => undefined);
      }
      const path = (await stat(small).catch(() => null)) ? small : src;
      return reply.type(path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg')
        .header('Cache-Control', 'private, max-age=86400').send(createReadStream(path));
    });
  });
}
