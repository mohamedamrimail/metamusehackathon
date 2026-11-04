import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';

// Every email the app sends goes through here. Addresses on reserved domains (RFC 2606/6761: example.com/.net/.org,
// *.example, *.test, *.invalid, *.localhost) are used by demo data and tests; mail to them is dropped so we never
// send to made-up addresses. A message with no real recipient left isn't sent at all.

const RESERVED = /@(?:[^@\s>]*\.)?(?:example\.(?:com|net|org)|[^@\s>]+\.(?:example|test|invalid|localhost))>?$/i;
export const isReservedAddress = (address: string) => RESERVED.test(address.trim());

type Address = string | { name?: string; address?: string };

const addressOf = (a: Address) => (typeof a === 'string' ? a : a.address ?? '');
/** Recipients without the reserved addresses (a comma-separated string is split first). */
export function realRecipients(r: unknown): Address[] {
  const list = (r === undefined || r === null ? [] : Array.isArray(r) ? r : [r]) as Address[];
  return list.flatMap((a): Address[] => (typeof a === 'string' ? a.split(',').map((s) => s.trim()).filter(Boolean) : [a]))
    .filter((a: Address) => !isReservedAddress(addressOf(a)));
}

export interface SentInfo { messageId?: string; skipped?: true }

/** nodemailer's transport, with reserved recipients dropped from to / cc / bcc. */
export function mailTransport(url: string) {
  const t = nodemailer.createTransport(url);
  return {
    async sendMail(mail: Mail.Options): Promise<SentInfo> {
      const to = realRecipients(mail.to);
      const cc = realRecipients(mail.cc);
      const bcc = realRecipients(mail.bcc);
      if (!to.length && !cc.length && !bcc.length) return { skipped: true };
      return t.sendMail({ ...mail, to: to as Mail.Options['to'], cc: cc.length ? cc as Mail.Options['cc'] : undefined, bcc: bcc.length ? bcc as Mail.Options['bcc'] : undefined });
    },
  };
}
