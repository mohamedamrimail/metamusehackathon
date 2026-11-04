import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { mailTransport } from './mailer.ts';
import { config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import type { AppDeps } from '../http/deps.ts';
import { runtimeSettings } from './settings.ts';

// Beta: new accounts wait until the team approves them. The request goes to APPROVAL_EMAIL with a link to a
// confirm page (a button, so mail scanners that open links can't approve). Accounts made before the beta gate,
// judges (judges' code), the demo account and ADMIN_EMAILS never wait. users.pending_approval_at = waiting.

type User = typeof users.$inferSelect;
const admins = () => config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

/** pending_approval_at for an account being created now (null = no approval needed). */
export async function approvalFor(db: Db, account: { email: string; accountKind: string }): Promise<Date | null> {
  if (account.accountKind !== 'user' || admins().includes(account.email.toLowerCase())) return null;
  return (await runtimeSettings(db)).requireApproval ? new Date() : null;
}

// Approval only ever goes one way, so approved ids can be remembered; pending ones are checked each time.
const approved = new Set<string>();

/** True while the account still waits for approval. */
export async function isPending(db: Db, userId: string): Promise<boolean> {
  if (approved.has(userId)) return false;
  const [u] = await db.select({ pending: users.pendingApprovalAt }).from(users).where(eq(users.id, userId));
  if (u && !u.pending) approved.add(userId);
  return Boolean(u?.pending);
}

// The session check (http/auth.ts requireUser) has no deps; buildApp hands it the db.
let gateDb: Db | undefined;
export const setApprovalDb = (db: Db) => { gateDb = db; };
export const pendingForSession = (userId: string) => (gateDb ? isPending(gateDb, userId) : Promise.resolve(false));

const sign = (userId: string) => createHmac('sha256', config.JWT_SECRET ?? 'dev-only-secret').update(`approve:${userId}`).digest('base64url');
export const approvalLink = (userId: string) => `${config.PUBLIC_URL}/api/approve/${userId}?sig=${sign(userId)}`;
export function validApprovalSig(userId: string, sig: string): boolean {
  const a = Buffer.from(sign(userId));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

const transport = () => (config.SMTP_URL ? mailTransport(config.SMTP_URL) : undefined);

/** Tells the team a new account waits. Never throws: sign-up must not fail on mail. */
export async function notifyNewAccount(deps: Pick<AppDeps, 'db'>, user: User, via: string, log?: { warn(o: object, m: string): void; info(o: object, m: string): void }) {
  if (!user.pendingApprovalAt) return;
  const text = [
    'A new i-persons account is waiting for approval (beta).',
    '',
    `Name: ${user.name}`,
    `Email: ${user.email}`,
    ...(user.phoneE164 ? [`WhatsApp: ${user.phoneE164}`] : []),
    `Signed up with: ${via}`,
    `Country: ${user.phoneCountry ?? user.signupCountry ?? 'unknown'}`,
    ...(user.inviteCode ? [`Invite code: ${user.inviteCode}`] : []),
    `At: ${user.createdAt.toISOString()}`,
    '',
    `Approve: ${approvalLink(user.id)}`,
    `Or in the admin panel: ${config.PUBLIC_URL}/admin (Users → Waiting for approval)`,
  ].join('\n');
  const t = transport();
  if (!t) { log?.info({ user: user.email }, 'approval request (no SMTP; approve in /admin)'); return; }
  await t.sendMail({ from: config.SMTP_FROM, to: config.APPROVAL_EMAIL, subject: `Approve new account: ${user.name} <${user.email}>`, text })
    .catch((err: unknown) => log?.warn({ err }, 'approval request email failed'));
}

/** Approves a waiting account and tells the person (WhatsApp for guests, else email). Returns the user, or undefined if it wasn't waiting. */
export async function approveUser(deps: Pick<AppDeps, 'db' | 'wa'>, userId: string): Promise<User | undefined> {
  const [u] = await deps.db.update(users).set({ pendingApprovalAt: null })
    .where(and(eq(users.id, userId), isNotNull(users.pendingApprovalAt))).returning();
  if (!u) return undefined;
  approved.add(u.id);
  const message = `Good news: your i-persons account is approved. Continue here: ${config.PUBLIC_URL}/${u.guestAt ? '' : 'onboarding'}`;
  if (u.guestAt && u.phoneE164 && deps.wa) {
    // Usually still inside the 24-hour window (they just wrote to us); if not, they'll see it on their next message.
    await deps.wa.sendText(u.phoneE164.replace(/^\+/, ''), 'Good news: your i-persons twin is approved. Ask me anything!').catch(() => {});
  } else if (!u.guestAt) {
    await transport()?.sendMail({ from: config.SMTP_FROM, to: u.email, subject: 'Your i-persons account is approved', text: `Hi ${u.name.split(/\s+/)[0]},\n\n${message}\n\n— the i-persons team` }).catch(() => {});
  }
  return u;
}
