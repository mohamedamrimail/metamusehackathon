import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { runtimeSettings } from '../lib/settings.ts';
import { actions, ipersons, users } from '../db/schema.ts';

// Phase 3b: email abuse limits. Counted from emails actually sent (done send_email actions).

/** Tools whose done actions sent an email from i-persons (contact invites count against the same limits). */
const EMAIL_TOOLS = ['send_email', 'invite_contact'];

export const EMAIL_LIMITS = { perHour: 5, perDay: 20, maxRecipients: 5, maxBodyChars: 5000 } as const;

/** null = allowed; otherwise a clear refusal for the user. */
export async function emailRefusal(db: Db, ipersonId: string, to: string[], body: string, now = new Date()): Promise<string | null> {
  const [row] = await db.select({ u: users }).from(ipersons).innerJoin(users, eq(users.id, ipersons.userId)).where(eq(ipersons.id, ipersonId));
  if (!row) return 'unknown user';
  if (!row.u.phoneE164) return 'Sending email needs a verified WhatsApp number. Verify it on My twin first.';
  if (row.u.emailSuspendedAt) return 'Email sending is suspended for this account. Contact contact@i-persons.com.';
  if (to.length > EMAIL_LIMITS.maxRecipients) return `At most ${EMAIL_LIMITS.maxRecipients} recipients per email.`;
  if (body.length > EMAIL_LIMITS.maxBodyChars) return `Emails can be at most ${EMAIL_LIMITS.maxBodyChars} characters.`;

  const day = new Date(now.getTime() - 86_400_000);
  const hour = new Date(now.getTime() - 3_600_000);
  // Each email counts 1; one that reaches a never-before-emailed address counts double.
  const seen = new Set<string>();
  const history = (await db.select({ args: actions.args, at: actions.decidedAt }).from(actions)
    .where(and(eq(actions.ipersonId, ipersonId), inArray(actions.tool, EMAIL_TOOLS), eq(actions.status, 'done'))).orderBy(actions.decidedAt));
  let hourUsed = 0;
  let dayUsed = 0;
  for (const h of history) {
    // WhatsApp invites go from the user's own WhatsApp; rows without recipients (the agent's proposal row) sent nothing themselves.
    if ((h.args as { channel?: string }).channel === 'whatsapp' || !((h.args as { to?: string[] }).to?.length)) continue;
    const recips = ((h.args as { to?: string[] }).to ?? []).map((x) => x.toLowerCase());
    const weight = recips.some((r) => !seen.has(r)) ? 2 : 1;
    recips.forEach((r) => seen.add(r));
    if (h.at && h.at >= day) dayUsed += weight;
    if (h.at && h.at >= hour) hourUsed += weight;
  }
  const next = to.some((r) => !seen.has(r.toLowerCase())) ? 2 : 1;
  const { emailPerHour, emailPerDay } = await runtimeSettings(db);
  if (hourUsed + next > emailPerHour) return `Email limit reached: at most ${emailPerHour} per hour (a first email to someone new counts double). Try again later.`;
  if (dayUsed + next > emailPerDay) return `Email limit reached: at most ${emailPerDay} per day. Try again tomorrow.`;
  return null;
}
