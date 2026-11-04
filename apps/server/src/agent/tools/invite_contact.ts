import { z } from 'zod';
import { emailRefusal } from '../email-limits.ts';
import { findContact, ownerOf } from '../../twins/agent-support.ts';
import { inviteRefusal, recordWhatsappInvite, sendEmailInvite } from '../../twins/invites.ts';
import { normaliseEmail } from '../../twins/identifiers.ts';
import { checkoutSender } from './prepare_checkout.ts';
import { defineTool } from './types.ts';

// "Invite my sister." Email invites are sent by i-persons after the user's yes; WhatsApp invites are
// never sent by i-persons: the user gets a link that opens their own WhatsApp with the text ready.

export default defineTool({
  name: 'invite_contact',
  description: 'Invite a contact who has no i-person yet, by email (sent by i-persons) or WhatsApp (the user sends it from their own WhatsApp; you send them the link). Needs approval.',
  risk: 'write',
  schema: z.object({
    contact: z.string().min(1).max(80).describe('The contact\'s name, or their role ("sister")'),
    channel: z.enum(['email', 'whatsapp']),
    message: z.string().max(600).optional().describe('Optional personal message; the invite link is added'),
    remind: z.boolean().default(false).describe('A reminder for an invite sent at least 7 days ago'),
  }),
  summarize: (a) => `${a.remind ? 'Remind' : 'Invite'} ${a.contact} to i-persons ${a.channel === 'email' ? 'by email' : 'via your WhatsApp'}`,
  async check(ctx, a) {
    const owner = await ownerOf(ctx);
    if (!owner) return 'unknown user';
    const c = await findContact(ctx.db, owner.id, a.contact);
    if (!c) return `No contact called ${a.contact}.`;
    const email = ((c.emails as string[]) ?? []).map(normaliseEmail).find(Boolean) ?? undefined;
    const refusal = await inviteRefusal(ctx.db, owner, c, a.channel, { remind: a.remind, email, now: ctx.now });
    if (refusal || a.channel !== 'email') return refusal;
    return emailRefusal(ctx.db, ctx.ipersonId, [email!], a.message ?? '', ctx.now);
  },
  async execute(ctx, a) {
    const owner = await ownerOf(ctx);
    const c = owner ? await findContact(ctx.db, owner.id, a.contact) : undefined;
    if (!owner || !c) throw new Error('contact not found');
    if (a.channel === 'email') {
      const email = ((c.emails as string[]) ?? []).map(normaliseEmail).find(Boolean) ?? '';
      const r = await sendEmailInvite(ctx.db, owner, c, { email, message: a.message, remind: a.remind, replyTo: true });
      return { invited: c.name, by: 'email', delivered: r.delivered };
    }
    const r = await recordWhatsappInvite(ctx.db, owner, c, { message: a.message, remind: a.remind });
    // The link goes to the user (chat + their own WhatsApp); they press send themselves.
    await checkoutSender.send?.(ctx.ipersonId, r.wa_link ? `Tap to send your invite to ${c.name} from your WhatsApp: ${r.wa_link}` : `Your invite for ${c.name}, to share: ${r.text}`);
    return { invited: c.name, by: 'whatsapp', link_sent_to_user: true };
  },
});
