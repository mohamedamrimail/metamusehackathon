import { and, eq, isNotNull } from 'drizzle-orm';
import { invites } from '../db/schema.ts';
import type { AppDeps } from '../http/deps.ts';
import { linkInvitedContact, requestConnection } from './connections.ts';
import { refreshIdentifiers } from './identifiers.ts';
import { payReferral } from './invites.ts';

// Small entry points the existing flows call (WhatsApp verification, sign-in, contact sync), so those
// files only gain one line each.

/**
 * After VERIFY <code>: the number becomes matchable; an accepted invite pays its referral credit and
 * offers "Connect your i-person with <First name>'s?" (connected only if the invitee accepts).
 */
export async function onPhoneVerified(deps: AppDeps, userId: string): Promise<void> {
  await refreshIdentifiers(deps.db, userId);
  await payReferral(deps.db, userId);
  const [inv] = await deps.db.select().from(invites).where(and(eq(invites.acceptedUserId, userId), isNotNull(invites.rewardedAt)));
  if (inv) {
    await requestConnection(deps, inv.inviterId, userId, { origin: 'invite' });
    await linkInvitedContact(deps.db, inv.inviterId, userId);
  }
}
