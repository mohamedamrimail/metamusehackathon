import { and, isNotNull, notExists, or, sql } from 'drizzle-orm';
import { userIdentifiers, users } from '../db/schema.ts';
import type { AppDeps } from '../http/deps.ts';
import { backfillConnectionContacts } from './connections.ts';
import { refreshIdentifiers } from './identifiers.ts';
import { matchAll } from './matching.ts';

// Background work for contacts and twin-to-twin planning.

/** Nightly: identifier hashes rebuilt from what is verified now, then every user's contacts re-matched. */
export async function twinsNightly(deps: AppDeps): Promise<void> {
  const people = await deps.db.select({ id: users.id }).from(users).where(or(isNotNull(users.phoneE164), isNotNull(users.emailVerifiedAt)));
  for (const p of people) await refreshIdentifiers(deps.db, p.id);
  await matchAll(deps.db);
}

/**
 * At start-up: verified accounts with no identifier hashes yet (e.g. verified before contact matching existed) become
 * matchable now instead of after the next nightly run, and everyone's contacts are matched against them.
 */
export async function backfillIdentifiers(deps: AppDeps): Promise<number> {
  const missing = await deps.db.select({ id: users.id }).from(users).where(and(
    or(isNotNull(users.phoneE164), isNotNull(users.emailVerifiedAt)),
    notExists(deps.db.select({ one: sql`1` }).from(userIdentifiers).where(sql`${userIdentifiers.userId} = ${users.id}`)),
  ));
  for (const p of missing) await refreshIdentifiers(deps.db, p.id);
  if (missing.length) await matchAll(deps.db);
  await backfillConnectionContacts(deps.db);
  return missing.length;
}
