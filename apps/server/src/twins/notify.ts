import { randomBytes } from 'node:crypto';
import { simulatedWa } from '../channels/whatsapp-client.ts';
import { logCall, withCall } from '../lib/call-log.ts';
import { eq } from 'drizzle-orm';
import { mailTransport } from '../lib/mailer.ts';
import { proposedEvent } from '../channels/events.ts';
import { config } from '../config.ts';
import { actions, ipersons, messages, users } from '../db/schema.ts';
import type { AppDeps } from '../http/deps.ts';
import { twinSettings } from './settings.ts';

// How twin-to-twin steps reach people: an approval card (web, and WhatsApp buttons inside the 24-hour
// window), the utility templates once Meta approved them (outside the window), else an email.

export type TwinCardKind = 'connect' | 'share_times' | 'send_options' | 'choose' | 'proceed_without' | 'confirm' | 'suggest';
export const TWIN_TEMPLATES = { connect: 'twin_connect_request', plan: 'twin_plan_request', confirmed: 'twin_plan_confirmed' } as const;

export interface CardInput {
  kind: TwinCardKind;
  args: Record<string, string | undefined>;
  summary: string;
  ttlMs: number;
  /** Template to use outside the 24 h window, with its body parameters (no line breaks allowed). */
  template?: { name: string; params: string[] };
  /** WhatsApp gets a third "Block" button (connection requests). */
  block?: boolean;
}

const short = (s: string) => s.replace(/\s*\n+\s*/g, ' · ').slice(0, 1000);

/** Creates an approval card (internal tool `twin_request`) for a user and notifies them. Never runs anything. */
export async function systemCard(deps: AppDeps, userId: string, card: CardInput) {
  const { db } = deps;
  const [ip] = await db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.userId, userId));
  if (!ip) return undefined;
  const now = new Date();
  const [action] = await db.insert(actions).values({
    ipersonId: ip.id, tool: 'twin_request', args: { kind: card.kind, ...card.args }, risk: 'write', status: 'proposed',
    summary: card.summary.slice(0, 500), confirmToken: randomBytes(18).toString('base64url'),
    expiresAt: new Date(now.getTime() + card.ttlMs),
    // Everything here comes from another person's twin: the card says so.
    influencedBy: card.kind === 'suggest' ? null : 'another i-person',
  }).returning();
  deps.bus.publish(ip.id, proposedEvent(action!));
  void logCall({ service: 'Twin-to-twin', what: `card for ${card.kind.replace('_', ' ')}: "${card.summary.slice(0, 80)}"` }, { userId });
  const buttons = [{ id: `ok:${action!.confirmToken}`, title: card.kind === 'connect' ? 'Accept' : 'Approve' }, { id: `no:${action!.confirmToken}`, title: 'Decline' }];
  if (card.block) buttons.push({ id: `bl:${action!.confirmToken}`, title: 'Block' });
  await reach(deps, userId, { text: card.summary, buttons, template: card.template, subject: 'Your i-person needs your yes' });
  return action!;
}

/** Seeds and scripts set this: cards are still created, but nothing goes out on WhatsApp or email. */
export const notifyOutside = { muted: false };

/** A message for a user, on WhatsApp (buttons/text → template → email fallback). Never throws. */
export async function reach(deps: AppDeps, userId: string, m: { text: string; buttons?: { id: string; title: string }[]; template?: { name: string; params: string[] }; subject: string }) {
  if (notifyOutside.muted) return 'card';
  const [u] = await deps.db.select().from(users).where(eq(users.id, userId));
  if (!u) return 'none';
  if (!deps.wa && u.phoneE164) simulatedWa(u.id, `${m.buttons?.length ? `card with ${m.buttons.map((b) => b.title).join(' / ')}` : 'text'}: "${m.text.slice(0, 70)}"`);
  if (deps.wa && u.phoneE164) {
    const to = u.phoneE164.replace(/^\+/, '');
    try {
      if (m.buttons?.length) await withCall({ userId: u.id }, () => deps.wa!.sendButtons(to, m.text, m.buttons!));
      else await withCall({ userId: u.id }, () => deps.wa!.sendText(to, m.text));
      return 'whatsapp';
    } catch (err) {
      // 131047: outside the 24-hour window. Templates only once Meta approved them.
      if (String((err as Error).message).includes('131047') && m.template && (await twinSettings(deps.db)).waTemplatesApproved) {
        const ok = await deps.wa.sendTemplate(to, m.template.name, config.WA_TEMPLATE_LANG, m.template.params.map(short)).then(() => true, () => false);
        if (ok) return 'template';
      }
    }
  }
  if (!config.SMTP_URL) return 'card';
  await mailTransport(config.SMTP_URL).sendMail({
    from: config.SMTP_FROM, to: u.email, subject: m.subject,
    text: `${m.text}\n\nOpen i-persons to answer: ${config.PUBLIC_URL}/contacts\n\n— your i-person`,
  }).catch(() => {});
  return 'email';
}

/** The twin says something in the owner's chats (web live sessions + the stored conversations). */
export async function twinSays(deps: AppDeps, userId: string, text: string, opts: { whatsapp?: boolean; template?: { name: string; params: string[] } } = {}) {
  const [ip] = await deps.db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.userId, userId));
  if (ip) {
    for (const channel of ['web', 'whatsapp'] as const) {
      const conversationId = await deps.runtime.conversationFor(ip.id, channel);
      await deps.db.insert(messages).values({ conversationId, role: 'assistant', content: text });
    }
    deps.bus.publish(ip.id, { type: 'agent.text', text, final: true, mood: 'happy' });
  }
  if (opts.whatsapp) await reach(deps, userId, { text, template: opts.template, subject: text.slice(0, 80) });
}
