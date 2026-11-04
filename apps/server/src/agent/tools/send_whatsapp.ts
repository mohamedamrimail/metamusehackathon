import { z } from 'zod';
import { imageFrom } from '../links.ts';
import { defineTool } from './types.ts';

// Only ever the owner's own verified number: nobody else can be reached, so no approval card is needed
// (messages to other people go through send_email, which is a write tool).

export default defineTool({
  name: 'send_whatsapp',
  description: 'Send the user a message on their own WhatsApp (e.g. "send me the latest news on WhatsApp"). Only reaches the user themself. '
    + 'Put the full content in the message, with links. For a suggestion, pass image_url (the item\'s page or a picture link) to send its picture too.',
  risk: 'read',
  schema: z.object({
    text: z.string().min(1).max(3500),
    image_url: z.url({ protocol: /^https?$/ }).max(1000).optional().describe('A picture for the message: a direct image link, or a page whose preview picture is used'),
  }),
  async execute(ctx, a) {
    if (!ctx.whatsappOwner) return { sent: false, error: 'The user has not linked a WhatsApp number yet; they can do it on My twin.' };
    // No usable picture is not a failure: the message goes as text.
    const image = a.image_url ? await imageFrom(a.image_url).catch(() => undefined) : undefined;
    try {
      await ctx.whatsappOwner(a.text, image);
      return a.image_url ? { sent: true, with_image: Boolean(image) } : { sent: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('131037')) return { sent: false, error: 'WhatsApp sending is paused until Meta approves the i-persons display name. Give the content here instead.' };
      return { sent: false, error: 'WhatsApp could not deliver the message right now. Give the content here instead.' };
    }
  },
});
