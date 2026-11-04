import { sql } from 'drizzle-orm';
import { config } from '../config.ts';
import type { Db } from '../db/client.ts';

// Shared metric helpers: only real users count (judges, the demo account and admins are left out).

const admins = () => config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
/** Real users, optionally only one cohort (Growth §2: admin metrics filtered by cohort). */
export const real = (cohort?: string) => sql`(select id from users where account_kind = 'user' and lower(email) not in (${sql.join([...admins(), ''].map((e) => sql`${e}`), sql`, `)})${cohort ? sql` and cohort = ${cohort}` : sql``})`;
export const realTwins = (cohort?: string) => sql`(select id from ipersons where user_id in ${real(cohort)})`;

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// Totals since launch (jury §7): the README "Traction" numbers. Real users only.
export async function metricsSummary(db: Db, cohort?: string) {
  const one = async (q: ReturnType<typeof sql>) => Number(((await db.execute(q)).rows[0] as { n: string | number | null } | undefined)?.n ?? 0);
  const totals = {
    signups: await one(sql`select count(*) n from users where id in ${real(cohort)}`),
    verified: await one(sql`select count(*) n from users where verified_at is not null and id in ${real(cohort)}`),
    twins_with_avatar: await one(sql`select count(*) n from ipersons where avatar_url is not null and id in ${realTwins(cohort)}`),
    active_users: await one(sql`select count(distinct c.iperson_id) n from messages m join conversations c on c.id = m.conversation_id where m.role = 'user' and c.iperson_id in ${realTwins(cohort)}`),
    turns: await one(sql`select count(*) n from messages m join conversations c on c.id = m.conversation_id where m.role = 'user' and c.iperson_id in ${realTwins(cohort)}`),
    voice_minutes: Math.round(await one(sql`select coalesce(sum((units->>'seconds')::numeric), 0) / 60 n from ai_usage where kind = 'stt' and user_id in ${real(cohort)}`) * 10) / 10,
    actions_proposed: await one(sql`select count(*) n from actions where risk <> 'read' and iperson_id in ${realTwins(cohort)}`),
    actions_approved: await one(sql`select count(*) n from actions where risk <> 'read' and status in ('done', 'confirmed', 'failed') and iperson_id in ${realTwins(cohort)}`),
    actions_declined: await one(sql`select count(*) n from actions where status = 'rejected' and iperson_id in ${realTwins(cohort)}`),
    actions_expired: await one(sql`select count(*) n from actions where status = 'expired' and risk <> 'read' and iperson_id in ${realTwins(cohort)}`),
    handoffs: await one(sql`select count(*) n from actions where tool = 'prepare_checkout' and status = 'done' and iperson_id in ${realTwins(cohort)}`),
    visitor_conversations: await one(sql`select count(*) n from visitor_conversations where iperson_id in ${realTwins(cohort)}`),
    partner_requests: await one(sql`select count(*) n from partner_requests where user_id in ${real(cohort)}`),
    partner_approved: await one(sql`select count(*) n from partner_requests where status = 'approved' and user_id in ${real(cohort)}`),
    // Retention: users active (≥1 turn) on two or more distinct days.
    // Impact §3: WhatsApp guests, how many finished on the web, and how much they talk.
    guests: await one(sql`select count(*) n from users where guest_at is not null and id in ${real(cohort)}`),
    guests_converted: await one(sql`select count(*) n from users where guest_at is not null and onboarded_at is not null and id in ${real(cohort)}`),
    guest_messages: await one(sql`select count(*) n from messages m join conversations c on c.id = m.conversation_id join ipersons i on i.id = c.iperson_id join users u on u.id = i.user_id where m.role = 'user' and u.guest_at is not null and u.id in ${real(cohort)}`),
    // Impact §4: pricing intent, gifts and family plans (anonymous buyers count; admin/judge/demo accounts don't).
    plus_interest: await one(sql`select count(*) n from plus_interest where user_id is null or user_id in ${real(cohort)}`),
    gift_requests: await one(sql`select count(*) n from gifts where buyer_user_id is null or buyer_user_id in ${real(cohort)}`),
    gifts_paid: await one(sql`select count(*) n from gifts where status in ('paid', 'redeemed') and (buyer_user_id is null or buyer_user_id in ${real(cohort)})`),
    gifts_redeemed: await one(sql`select count(*) n from gifts where status = 'redeemed' and redeemed_by in ${real(cohort)}`),
    family_groups: await one(sql`select count(*) n from family_groups where owner_id in ${real(cohort)}`),
    family_members: await one(sql`select count(*) n from family_members where user_id in ${real(cohort)}`),
    // Impact §9: waitlist demand (people, countries, joined through someone's share link).
    waitlist: await one(sql`select count(*) n from waitlist`),
    waitlist_countries: await one(sql`select count(distinct country) n from waitlist where country is not null`),
    waitlist_from_shares: await one(sql`select count(*) n from waitlist where referred_by is not null`),
    retained_users: await one(sql`select count(*) n from (select c.iperson_id from messages m join conversations c on c.id = m.conversation_id where m.role = 'user' and c.iperson_id in ${realTwins(cohort)} group by 1 having count(distinct date_trunc('day', m.created_at)) >= 2) t`),
  };
  const perDay = ((await db.execute(sql`select sum(meta_cost_micros) / 1e6 n from ai_usage where user_id in ${real(cohort)} group by user_id, date_trunc('day', created_at)`)).rows as { n: string }[]).map((r) => Number(r.n));
  const avg = perDay.length ? perDay.reduce((a, b) => a + b, 0) / perDay.length : 0;
  return { ...totals, cost_per_active_user_day_avg_usd: Math.round(avg * 10000) / 10000, cost_per_active_user_day_median_usd: Math.round(median(perDay) * 10000) / 10000 };
}

/**
 * Growth §2: invites per inviting user, invite → sign-up → verified conversion, viral coefficient
 * k = verified invitees / inviting users, share of users with ≥1 connected twin, plans booked.
 */
export async function growthMetrics(db: Db, opts: { cohort?: string; since?: Date } = {}) {
  const since = opts.since ?? new Date(0);
  const one = async (q: ReturnType<typeof sql>) => Number(((await db.execute(q)).rows[0] as { n: string | number | null } | undefined)?.n ?? 0);
  const users = real(opts.cohort);
  const inviters = await one(sql`select count(distinct inviter_id) n from invites where sent_at >= ${since} and inviter_id in ${users}`);
  const sent = await one(sql`select count(*) n from invites where sent_at >= ${since} and inviter_id in ${users}`);
  const signedUp = await one(sql`select count(*) n from invites where sent_at >= ${since} and accepted_user_id is not null and inviter_id in ${users}`);
  const verified = await one(sql`select count(*) n from invites i join users u on u.id = i.accepted_user_id where i.sent_at >= ${since} and u.verified_at is not null and i.inviter_id in ${users}`);
  const total = await one(sql`select count(*) n from users where id in ${users}`);
  const connected = await one(sql`select count(distinct x) n from (select requester_id x from twin_connections where status = 'active' union all select recipient_id from twin_connections where status = 'active') t where x in ${users}`);
  const plans = await one(sql`select count(*) n from plan_sessions where status = 'booked' and updated_at >= ${since} and creator_id in ${users}`);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    inviting_users: inviters, invites_sent: sent, invites_per_inviting_user: inviters ? Math.round((sent / inviters) * 100) / 100 : 0,
    invite_to_signup_pct: pct(signedUp, sent), signup_to_verified_pct: pct(verified, signedUp),
    k: inviters ? Math.round((verified / inviters) * 100) / 100 : 0,
    users: total, users_with_connected_twin_pct: pct(connected, total), plans_booked: plans,
  };
}

/** Distinct cohort labels in use (codes and users). */
export async function cohorts(db: Db): Promise<string[]> {
  const rows = (await db.execute(sql`select cohort from invite_codes where cohort is not null union select cohort from users where cohort is not null order by 1`)).rows as { cohort: string }[];
  return rows.map((r) => r.cohort);
}
