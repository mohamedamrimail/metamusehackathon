import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { conversations, feedback, ipersons, messages, users } from '../db/schema.ts';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

// Jury §7: a small, optional "How useful is your i-person?" prompt. Talk asks once after the user's 5th
// turn (answering or dismissing ends it); My twin always offers it. Quotable answers go to the README.

export const FEEDBACK_AFTER_TURNS = 5;

export async function feedbackRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  app.addHook('preHandler', requireUser);
  const isAdmin = async (userId: string) => {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    return Boolean(u && config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).includes(u.email));
  };

  app.get('/me/feedback/status', async (req) => {
    const [u] = await db.select({ kind: users.accountKind }).from(users).where(eq(users.id, req.user.sub));
    const [asked] = await db.select({ n: count() }).from(feedback).where(and(eq(feedback.userId, req.user.sub), eq(feedback.context, 'talk')));
    const twins = (await db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.userId, req.user.sub))).map((r) => r.id);
    const [turns] = twins.length
      ? await db.select({ n: count() }).from(messages).innerJoin(conversations, eq(conversations.id, messages.conversationId)).where(and(inArray(conversations.ipersonId, twins), eq(messages.role, 'user')))
      : [{ n: 0 }];
    // Demo accounts (filmed, shared by judges) are never interrupted.
    return { due: u?.kind !== 'demo' && (asked?.n ?? 0) === 0 && (turns?.n ?? 0) >= FEEDBACK_AFTER_TURNS };
  });

  app.post('/me/feedback', async (req, reply) => {
    const body = z.object({
      rating: z.number().int().min(1).max(5).nullable(), text: z.string().trim().max(500).optional(),
      quotable: z.boolean().default(false), context: z.enum(['talk', 'twin']),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    await db.insert(feedback).values({ userId: req.user.sub, rating: body.data.rating, text: body.data.text || null, quotable: body.data.quotable && Boolean(body.data.text), context: body.data.context });
    return reply.code(201).send({ ok: true });
  });

  app.get<{ Querystring: { quotable?: string } }>('/admin/feedback', async (req, reply) => {
    if (!(await isAdmin(req.user.sub))) return reply.code(403).send({ error: 'forbidden' });
    const rows = await db.select({ f: feedback, name: users.name, kind: users.accountKind }).from(feedback).innerJoin(users, eq(users.id, feedback.userId))
      .where(req.query.quotable === '1' ? eq(feedback.quotable, true) : undefined).orderBy(desc(feedback.createdAt)).limit(200);
    return {
      feedback: rows.filter((r) => r.f.rating !== null || r.f.text).map((r) => ({
        id: r.f.id, rating: r.f.rating, text: r.f.text, quotable: r.f.quotable, context: r.f.context, created_at: r.f.createdAt,
        // Quotes are attributed by first name only.
        first_name: r.name.split(/\s+/)[0], account_kind: r.kind,
      })),
    };
  });
}
