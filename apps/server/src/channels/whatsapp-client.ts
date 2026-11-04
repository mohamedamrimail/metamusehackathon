import { config } from '../config.ts';
import { clip, logCall } from '../lib/call-log.ts';

// WhatsApp Cloud API sender (patterns from the team's Lahja/Kimbiala services).

export interface WaSender {
  sendText(to: string, body: string): Promise<void>;
  /** Interactive message with up to 3 reply buttons; ids come back in the webhook. */
  sendButtons(to: string, body: string, buttons: { id: string; title: string }[]): Promise<void>;
  downloadMedia(mediaId: string): Promise<Buffer>;
  /** Pre-approved template: the only way to message a user outside the 24 h window. */
  sendTemplate(to: string, name: string, lang: string, params: string[]): Promise<void>;
  /** An image (uploaded to WhatsApp's media store first, so our files stay private) with a caption. */
  sendImage(to: string, image: Buffer, mime: string, caption: string): Promise<void>;
}

/** North American numbers 555-0100…555-0199 are reserved for fiction; the demo accounts use them. */
export const isFictionalNumber = (to: string) => /^\+?1\d{3}55501\d{2}$/.test(to.replace(/[\s-]/g, ''));

export function createWaSender(): WaSender | undefined {
  const token = config.WA_ACCESS_TOKEN;
  const phoneId = config.WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) return undefined;
  const graph = `https://graph.facebook.com/${config.WA_GRAPH_VERSION}`;

  const post = async (payload: unknown, attempt = 0): Promise<void> => {
    // DEMO: demo accounts carry fictional numbers (+1 NXX 555-01XX); nothing is ever sent to them.
    if (isFictionalNumber(String((payload as { to?: unknown }).to ?? ''))) return;
    const res = await fetch(`${graph}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return;
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return post(payload, attempt + 1);
    }
    throw new Error(`WhatsApp send failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  };

  return {
    sendText: (to, body) => post({ messaging_product: 'whatsapp', to, type: 'text', text: { body: body.slice(0, 4096) } }),
    sendButtons: (to, body, buttons) => post({
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, 1024) },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
      },
    }),
    sendTemplate: (to, name, lang, params) => post({
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name, language: { code: lang }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: text.slice(0, 1000) })) }] },
    }),
    async sendImage(to, image, mime, caption) {
      if (isFictionalNumber(to)) return;
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', mime);
      form.append('file', new Blob([new Uint8Array(image)], { type: mime }), mime === 'image/png' ? 'avatar.png' : 'avatar.jpg');
      const up = await fetch(`${graph}/${phoneId}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(20_000) });
      if (!up.ok) throw new Error(`WhatsApp media upload failed: HTTP ${up.status}`);
      const { id } = (await up.json()) as { id: string };
      await post({ messaging_product: 'whatsapp', to, type: 'image', image: { id, ...(caption ? { caption: caption.slice(0, 1024) } : {}) } });
    },
    async downloadMedia(mediaId) {
      const auth = { Authorization: `Bearer ${token}` };
      const meta = await fetch(`${graph}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
      if (!meta.ok) throw new Error(`media info failed: HTTP ${meta.status}`);
      const { url, file_size } = (await meta.json()) as { url: string; file_size?: number };
      if (file_size && file_size > 16_000_000) throw new Error('media too large');
      const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/**
 * A message to a user's own number: free text inside the 24-hour window, else the approved update
 * template (Meta error 131047 = outside the window). Template parameters can't hold line breaks.
 */
export async function sendToOwner(
  wa: WaSender, to: string, text: string, template: { name: string; lang: string }, image?: { data: Buffer; mime: string },
): Promise<void> {
  try {
    // A caption holds 1024 characters; longer texts follow the picture as their own message.
    if (image && text.length <= 1024) return await wa.sendImage(to, image.data, image.mime, text);
    if (image) await wa.sendImage(to, image.data, image.mime, '');
    await wa.sendText(to, text);
  } catch (err) {
    if (!String(err instanceof Error ? err.message : err).includes('131047')) throw err;
    const line = text.replace(/\s*\n+\s*/g, ' · ').replace(/\s{4,}/g, ' ').slice(0, 1000);
    await wa.sendTemplate(to, template.name, template.lang, [line]);
  }
}

/**
 * DEMO: logs every outgoing WhatsApp message for the Meta AI calls panel (lib/call-log.ts). Messages to the demo
 * accounts' fictional numbers are never sent, so they show as simulated.
 */
export function loggedWa(wa: WaSender | undefined): WaSender | undefined {
  if (!wa) return undefined;
  const log = (to: string, what: string) => void logCall({ service: 'WhatsApp', what, ...(isFictionalNumber(to) ? { simulated: 'fictional demo number: not sent' } : {}) });
  return {
    ...wa,
    sendText: async (to, body) => { await wa.sendText(to, body); log(to, `text to the owner: "${clip(body, 70)}"`); },
    sendButtons: async (to, body, buttons) => { await wa.sendButtons(to, body, buttons); log(to, `card with ${buttons.map((b) => b.title).join(' / ')}: "${clip(body, 60)}"`); },
    sendTemplate: async (to, name, lang, params) => { await wa.sendTemplate(to, name, lang, params); log(to, `template ${name} (outside the 24 h window)`); },
    sendImage: async (to, image, mime, caption) => { await wa.sendImage(to, image, mime, caption); log(to, `picture: "${clip(caption, 60)}"`); },
  };
}

/** DEMO: WhatsApp isn't configured on this server: log what would have gone out (Meta AI calls panel). */
export const simulatedWa = (userId: string, what: string) =>
  void logCall({ service: 'WhatsApp', what, simulated: 'WhatsApp not configured on this server' }, { userId });
