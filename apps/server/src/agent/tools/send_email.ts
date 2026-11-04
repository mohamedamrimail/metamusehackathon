import { mailTransport } from '../../lib/mailer.ts';
import { z } from 'zod';
import { config } from '../../config.ts';
import { EMAIL_LIMITS, emailRefusal } from '../email-limits.ts';
import { defineTool } from './types.ts';

const transport = config.SMTP_URL ? mailTransport(config.SMTP_URL) : undefined;

export default defineTool({
  name: 'send_email',
  description: 'Send an email on the user\'s behalf (e.g. invitations). Needs confirmation. The signature is added automatically.',
  risk: 'write',
  schema: z.object({
    to: z.array(z.email()).min(1).max(EMAIL_LIMITS.maxRecipients),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(EMAIL_LIMITS.maxBodyChars),
  }),
  summarize: (a) => `Email "${a.subject}" to ${a.to.length > 3 ? `${a.to.slice(0, 3).join(', ')} +${a.to.length - 3}` : a.to.join(', ')}`,
  // Verified senders only, within the abuse limits (Phase 3b); checked again right before sending.
  check: (ctx, a) => emailRefusal(ctx.db, ctx.ipersonId, a.to, a.body, ctx.now),
  async execute(ctx, a) {
    const refusal = await emailRefusal(ctx.db, ctx.ipersonId, a.to, a.body);
    if (refusal) throw new Error(refusal);
    // SPEC safety rule: outgoing messages say they come from the i-person, never pretend to be human.
    const text = `${a.body}\n\n— sent by ${ctx.userName}'s i-person\n--\nSent by an AI twin at i-persons.com, with ${ctx.userName}'s approval. Unwanted or abusive? Report it: https://i-persons.com/report-abuse.html`;
    // DEMO: demo accounts never send real email (their recipients are made up); Activity keeps it as the outbox.
    if (!transport || ctx.demo) {
      // HACKATHON: no SMTP configured; the action log keeps the full message as the "outbox".
      return { delivered: false, outbox: true, to: a.to, subject: a.subject, text };
    }
    const info = await transport.sendMail({ from: config.SMTP_FROM, to: a.to, subject: a.subject, text });
    // Reserved addresses (example.com …) are never mailed (lib/mailer.ts): that message stays in the outbox.
    if (info.skipped) return { delivered: false, outbox: true, to: a.to, subject: a.subject, text, note: 'not sent: example/test addresses only' };
    return { delivered: true, message_id: info.messageId, to: a.to };
  },
});
