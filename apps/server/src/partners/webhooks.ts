import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { partnerWebhooks, webhookDeliveries } from '../db/schema.ts';

// Partner webhooks (P5): signed HMAC-SHA256 over "<timestamp>.<body>", retried with exponential backoff
// for 24 h, every delivery logged.

export const WEBHOOK_EVENTS = ['match.created', 'request.approved', 'request.declined', 'request.expired', 'offer.dismissed', 'user.revoked', 'reservation.requested', 'reservation.cancelled'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** X-IPersons-Signature: "t=<unix>,v1=<hex>"; receivers reject anything older than 5 minutes. */
export function sign(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function verifySignature(secret: string, body: string, header: string, now = Date.now()): boolean {
  const t = Number(/t=(\d+)/.exec(header)?.[1]);
  const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1];
  if (!t || !v1 || Math.abs(now / 1000 - t) > 300) return false;
  return sign(secret, body, t) === `t=${t},v1=${v1}`;
}

/** Queues the event for every webhook of the partner subscribed to it. */
export async function emit(db: Db, partnerId: string, event: WebhookEvent, data: Record<string, unknown>) {
  const hooks = await db.select().from(partnerWebhooks).where(eq(partnerWebhooks.partnerId, partnerId));
  const targets = hooks.filter((h) => (h.events as string[]).length === 0 || (h.events as string[]).includes(event));
  if (!targets.length) return;
  const payload = { id: `evt_${randomBytes(9).toString('base64url')}`, type: event, created: Math.floor(Date.now() / 1000), data };
  await db.insert(webhookDeliveries).values(targets.map((h) => ({ webhookId: h.id, event, payload })));
}

const DAY = 86_400_000;
export type Poster = (url: string, body: string, headers: Record<string, string>) => Promise<number>;
const httpPost: Poster = async (url, body, headers) => (await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(10_000), redirect: 'manual' })).status;

/** Delivers what's due; called every few seconds by the server. */
export async function deliverDue(db: Db, post: Poster = httpPost, now = new Date()) {
  const due = await db.select({ d: webhookDeliveries, h: partnerWebhooks }).from(webhookDeliveries)
    .innerJoin(partnerWebhooks, eq(partnerWebhooks.id, webhookDeliveries.webhookId))
    .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now))).limit(50);
  for (const { d, h } of due) {
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(now.getTime() / 1000);
    let status = 0;
    let error: string | null = null;
    try {
      status = await post(h.url, body, { 'Content-Type': 'application/json', 'X-IPersons-Event': d.event, 'X-IPersons-Signature': sign(h.secret, body, ts), 'User-Agent': 'i-persons-webhooks/1' });
    } catch (err) {
      error = String((err as Error).message).slice(0, 200);
    }
    const attempts = d.attempts + 1;
    if (status >= 200 && status < 300) {
      await db.update(webhookDeliveries).set({ status: 'delivered', attempts, lastError: null }).where(eq(webhookDeliveries.id, d.id));
    } else {
      // 1 min, 2, 4 … capped at 2 h; give up 24 h after the event.
      const next = new Date(now.getTime() + Math.min(2 ** (attempts - 1) * 60_000, 2 * 3_600_000));
      const giveUp = next.getTime() - d.createdAt.getTime() > DAY;
      await db.update(webhookDeliveries).set({ status: giveUp ? 'failed' : 'pending', attempts, nextAttemptAt: next, lastError: error ?? `HTTP ${status}` }).where(eq(webhookDeliveries.id, d.id));
    }
  }
  return due.length;
}
