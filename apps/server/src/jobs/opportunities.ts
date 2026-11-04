import { Queue, Worker } from 'bullmq';
import { sendWeeklySummaries } from '../http/impact.ts';
import { eq, or } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { listFacts } from '../agent/memory.ts';
import { hasCredit, meteredLlm } from '../billing/credits.ts';
import findOpportunities from '../agent/tools/find_opportunities.ts';
import { config } from '../config.ts';
import { bookings, connections, ipersons, messages, notifications, partnerOffers, purchases, users } from '../db/schema.ts';
import { refreshInsights, syncMailbox } from '../mail/sync.ts';
import { matchOffer } from '../partners/matching.ts';
import type { AppDeps } from '../http/deps.ts';
import { twinsNightly } from '../twins/jobs.ts';
import { suggestPlans } from '../twins/suggestions.ts';

// Background i-person: looks for opportunities worth telling the user about (SPEC: Background i-person).

interface Item { title: string; why?: string; price?: string; when?: string; url?: string }

export async function scanOpportunities(deps: AppDeps, ipersonId: string): Promise<{ sent: Item[] }> {
  const [row] = await deps.db.select({ ip: ipersons, user: users }).from(ipersons)
    .innerJoin(users, eq(users.id, ipersons.userId)).where(eq(ipersons.id, ipersonId));
  if (!row) return { sent: [] };
  // Scans run on the user's AI credit; with none left they simply stop.
  if (deps.billing && !(await hasCredit(deps.db, row.user.id))) return { sent: [] };
  const llm = deps.billing ? meteredLlm(deps.llm, deps.db, row.user.id, config.META_LLM_MODEL) : deps.llm;

  const facts = await listFacts(deps.db, ipersonId, { limit: 60 });
  const travel = facts.find((f) => f.key.includes('travel'))?.value;
  const goals = facts.filter((f) => f.category === 'goal').map((f) => f.value).join('; ');
  const res = await findOpportunities.execute(
    { db: deps.db, llm, ipersonId, userName: row.user.name, timezone: row.user.timezone, now: new Date() },
    travel
      ? { kind: 'travel', query: `New travel deals matching: ${travel}`, constraints: goals || undefined }
      : { kind: 'deal', query: `Opportunities matching these goals: ${goals || 'general interests'}` },
  ) as { items: Item[] };

  const fresh: Item[] = [];
  for (const item of res.items ?? []) {
    const dedupeKey = createHash('sha1').update(item.title.trim().toLowerCase()).digest('hex');
    const [inserted] = await deps.db.insert(notifications)
      .values({ ipersonId, kind: 'opportunity', dedupeKey, payload: item })
      .onConflictDoNothing().returning({ id: notifications.id });
    if (inserted) fresh.push(item);
  }
  if (!fresh.length) return { sent: [] };

  const line = fresh.slice(0, 3).map((i) => `${i.title}${i.price ? ` (${i.price})` : ''}`).join('; ');
  const text = `I found something for you: ${line}. Want details?`;

  // Kept in both conversations so a reply on either channel has the context.
  for (const channel of ['web', 'whatsapp'] as const) {
    const conversationId = await deps.runtime.conversationFor(ipersonId, channel);
    await deps.db.insert(messages).values({ conversationId, role: 'assistant', content: text });
  }
  deps.bus.publish(ipersonId, { type: 'agent.text', text, final: true });

  if (deps.wa && row.user.phoneE164) {
    const to = row.user.phoneE164.replace(/^\+/, '');
    try {
      // Proactive = outside the 24 h window, so the approved template is required.
      await deps.wa.sendTemplate(to, config.WA_UPDATE_TEMPLATE, config.WA_TEMPLATE_LANG, [line]);
    } catch {
      // HACKATHON: template not approved yet — plain text still works inside the 24 h window.
      await deps.wa.sendText(to, text).catch(() => {});
    }
  }
  return { sent: fresh };
}

/** Repeating BullMQ job that scans every i-person. Returns a stop function. */
export function startScheduler(deps: AppDeps, log: { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void }) {
  if (config.SCAN_EVERY_HOURS <= 0) return async () => {};
  if (!config.REDIS_URL) {
    log.info({}, 'REDIS_URL is not set: background jobs (scans, mailbox sync, nightly matching) are off');
    return async () => {};
  }
  // The API must keep running even if Redis is down: scheduler errors are logged, never thrown.
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => log.error({ err }, 'redis error (scheduler)'));
  const queue = new Queue('opportunities', { connection });
  queue.upsertJobScheduler('scan-all', { every: config.SCAN_EVERY_HOURS * 3_600_000 }, { name: 'scan-all' })
    .then(() => log.info({ everyHours: config.SCAN_EVERY_HOURS }, 'opportunity scheduler started'))
    .catch((err) => log.error({ err }, 'could not schedule opportunity scans'));

  // Mailbox (addendum 2): incremental sync every MAIL_SYNC_POLL_MINUTES; insights refreshed nightly.
  queue.upsertJobScheduler('mail-sync', { every: config.MAIL_SYNC_POLL_MINUTES * 60_000 }, { name: 'mail-sync' })
    .catch((err) => log.error({ err }, 'could not schedule mail sync'));
  queue.upsertJobScheduler('partners-nightly', { pattern: '30 3 * * *' }, { name: 'partners-nightly' })
    .catch((err) => log.error({ err }, 'could not schedule partner matching'));
  queue.upsertJobScheduler('insights-nightly', { pattern: '0 3 * * *' }, { name: 'insights-nightly' })
    .catch((err) => log.error({ err }, 'could not schedule insights'));
  // Impact §1: Sunday-evening "time given back" summary on WhatsApp, for users who opted in.
  queue.upsertJobScheduler('weekly-impact', { pattern: '0 18 * * 0' }, { name: 'weekly-impact' })
    .catch((err) => log.error({ err }, 'could not schedule weekly summaries'));
  queue.upsertJobScheduler('twins-nightly', { pattern: '15 3 * * *' }, { name: 'twins-nightly' })
    .catch((err) => log.error({ err }, 'could not schedule contact matching'));

  const worker = new Worker('opportunities', async (job) => {
    if (job.name === 'mail-sync') {
      const boxes = await deps.db.select({ id: connections.id }).from(connections).where(or(eq(connections.kind, 'mail_microsoft'), eq(connections.kind, 'mail_google')));
      for (const b of boxes) await syncMailbox(deps, b.id).catch((err) => log.error({ err, connection: b.id }, 'mail sync failed'));
      return;
    }
    if (job.name === 'partners-nightly') {
      // New consenting users get matched to open offers.
      const open = await deps.db.select({ id: partnerOffers.id }).from(partnerOffers).where(eq(partnerOffers.status, 'open'));
      for (const o of open) await matchOffer(deps, o.id).catch((err) => log.error({ err, offer: o.id }, 'matching failed'));
      return;
    }
    if (job.name === 'weekly-impact') {
      log.info({ sent: await sendWeeklySummaries(deps) }, 'weekly impact summaries');
      return;
    }
    if (job.name === 'twins-nightly') {
      await twinsNightly(deps).catch((err) => log.error({ err }, 'contact matching failed'));
      return;
    }
    if (job.name === 'insights-nightly') {
      const people = await deps.db.selectDistinct({ id: purchases.userId }).from(purchases)
        .union(deps.db.selectDistinct({ id: bookings.userId }).from(bookings));
      for (const u of people) await refreshInsights(deps, u.id).catch((err) => log.error({ err }, 'insights failed'));
      return;
    }
    const all = await deps.db.select({ id: ipersons.id }).from(ipersons);
    let sent = 0;
    for (const { id } of all) {
      try {
        sent += (await scanOpportunities(deps, id)).sent.length;
        // Twin-to-twin (§5d): at most one plan suggestion a week, only where both sides allowed it.
        const [owner] = await deps.db.select({ userId: ipersons.userId }).from(ipersons).where(eq(ipersons.id, id));
        if (owner) await suggestPlans(deps, owner.userId).catch((err) => log.error({ err, ipersonId: id }, 'plan suggestion failed'));
      } catch (err) {
        log.error({ err, ipersonId: id }, 'opportunity scan failed');
      }
    }
    log.info({ ipersons: all.length, sent }, 'opportunity scan done');
  }, { connection, concurrency: 1 });
  worker.on('failed', (_job, err) => log.error({ err }, 'opportunity job failed'));

  return async () => {
    await worker.close();
    await queue.close();
    connection.disconnect();
  };
}
