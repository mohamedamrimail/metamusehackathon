import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { timeEstimates, users } from '../db/schema.ts';
import { sendToOwner } from '../channels/whatsapp-client.ts';
import { currentEstimates, formatMinutes, IMPACT_KINDS, IMPACT_LABELS, timeGivenBack } from '../lib/impact.ts';
import { runtimeSettings } from '../lib/settings.ts';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

// Impact §1 "time given back": public method + optional counter, the user's own figure, weekly
// WhatsApp summary (opt-in), and the admin view with editable estimates.

const WEEK = 7 * 86_400_000;
const isAdminEmail = (email?: string) => Boolean(email && config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).includes(email));

export async function impactRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  // Public: the method page and the landing counter (only when the admin switched it on).
  app.get('/impact/estimates', async () => ({ estimates: await currentEstimates(db), rule: 'Only actions you approved and that were completed count. These are conservative estimates.' }));
  app.get('/impact/total', async () => {
    if (!(await runtimeSettings(db)).showImpactCounter) return { show: false };
    return { show: true, hours: Math.round((await timeGivenBack(db)).minutes / 6) / 10 };
  });

  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);

    scope.get('/me/impact', async (req) => {
      const [week, total] = await Promise.all([
        timeGivenBack(db, { userId: req.user.sub, since: new Date(Date.now() - WEEK) }),
        timeGivenBack(db, { userId: req.user.sub }),
      ]);
      const [u] = await db.select({ weekly: users.weeklySummary }).from(users).where(eq(users.id, req.user.sub));
      return { week_minutes: week.minutes, week_text: formatMinutes(week.minutes), total_minutes: total.minutes, total_text: formatMinutes(total.minutes), weekly_summary: Boolean(u?.weekly) };
    });

    scope.patch('/me/weekly-summary', async (req, reply) => {
      const body = z.object({ on: z.boolean() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid' });
      await db.update(users).set({ weeklySummary: body.data.on }).where(eq(users.id, req.user.sub));
      return { ok: true };
    });

    const admin = async (userId: string) => {
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
      return isAdminEmail(u?.email) ? u!.email : undefined;
    };

    scope.get<{ Querystring: { days?: string } }>('/admin/impact', async (req, reply) => {
      if (!(await admin(req.user.sub))) return reply.code(403).send({ error: 'forbidden' });
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 28));
      const since = new Date(Date.now() - days * 86_400_000);
      const r = await timeGivenBack(db, { since });
      const all = await timeGivenBack(db);
      // Per day and per ISO week, split by kind; per user (top 20).
      const dayOf = (d: Date) => d.toISOString().slice(0, 10);
      const weekOf = (d: Date) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return dayOf(x); };
      const history = await db.select().from(timeEstimates);
      const minutesAt = (kind: string, at: Date) => history.filter((e) => e.kind === kind && e.validFrom <= at).sort((a, b) => +a.validFrom - +b.validFrom).at(-1)?.minutes ?? 0;
      const bucket = (key: (d: Date) => string) => {
        const out: Record<string, Record<string, number>> = {};
        for (const ev of r.events) {
          const k = key(ev.at);
          (out[k] ??= {})[ev.kind] = ((out[k] ??= {})[ev.kind] ?? 0) + minutesAt(ev.kind, ev.at) * ev.count;
        }
        return out;
      };
      const perUser: Record<string, number> = {};
      for (const ev of r.events) perUser[ev.userId] = (perUser[ev.userId] ?? 0) + minutesAt(ev.kind, ev.at) * ev.count;
      return {
        total_minutes: all.minutes, period_minutes: r.minutes, by_kind: r.byKind, per_day: bucket(dayOf), per_week: bucket(weekOf),
        users: Object.entries(perUser).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, m]) => ({ user_id: id, minutes: Math.round(m) })),
        estimates: await currentEstimates(db),
      };
    });

    // An edit adds a row valid from now: past actions keep the estimate they were counted with.
    scope.put('/admin/impact/estimates', async (req, reply) => {
      const email = await admin(req.user.sub);
      if (!email) return reply.code(403).send({ error: 'forbidden' });
      const body = z.object({ kind: z.enum(IMPACT_KINDS), minutes: z.number().min(0).max(600), justification: z.string().trim().min(3).max(200) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid' });
      await db.insert(timeEstimates).values({ ...body.data, updatedBy: email });
      return { estimates: await currentEstimates(db) };
    });
  });
}

/** Weekly WhatsApp summary for users who opted in (free text inside 24 h, else the update template). */
export async function sendWeeklySummaries(deps: AppDeps) {
  if (!deps.wa) return 0;
  const opted = await deps.db.select({ id: users.id, phone: users.phoneE164 }).from(users).where(eq(users.weeklySummary, true));
  let sent = 0;
  for (const u of opted) {
    if (!u.phone) continue;
    const week = await timeGivenBack(deps.db, { userId: u.id, since: new Date(Date.now() - WEEK) });
    if (week.minutes < 1) continue;
    const top = Object.entries(week.byKind).sort((a, b) => b[1].minutes - a[1].minutes)[0];
    const text = `Your i-person gave you back about ${formatMinutes(week.minutes)} this week${top ? ` (mostly: ${IMPACT_LABELS[top[0] as keyof typeof IMPACT_LABELS].toLowerCase()})` : ''}. How we count: ${config.PUBLIC_URL}/impact-method`;
    await sendToOwner(deps.wa, u.phone.replace(/^\+/, ''), text, { name: config.WA_UPDATE_TEMPLATE, lang: config.WA_TEMPLATE_LANG }).then(() => sent++).catch(() => {});
  }
  return sent;
}
