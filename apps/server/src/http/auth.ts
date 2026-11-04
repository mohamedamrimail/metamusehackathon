import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AGE_RANGES, CONSENT_VERSION, CURRENCIES, GENDERS, LANGUAGES, SETUP_STEPS, type Gender } from '@ipersons/shared';
import { creditSummary, microsToUsd, usdToMicros } from '../billing/credits.ts';
import { config, showSimulations } from '../config.ts';
import { ipersons, users, waitlist } from '../db/schema.ts';
import { countryAllowed, countrySettings, loginDecision, signupDecision } from '../geo/countries.ts';
import { approvalFor, notifyNewAccount, pendingForSession } from '../lib/approval.ts';
import { hashPassword, verifyPassword } from '../lib/password.ts';
import { HOUR, limited, MIN } from '../lib/ratelimit.ts';
import { runtimeSettings } from '../lib/settings.ts';
import type { AppDeps } from './deps.ts';
import { acceptInvite, joinBypassesCountry } from '../twins/invites.ts';

export const SESSION_COOKIE = 'ip_session';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

const Register = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(80),
  invite_code: z.string().trim().max(40).optional(),
  /** A personal invite link's token (/join/<token>), see twins/invites.ts. */
  join_token: z.string().trim().max(64).optional(),
});
const Login = z.object({ email: z.string().transform((e) => e.toLowerCase()), password: z.string() });

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify({ onlyCookie: true });
  } catch {
    return reply.code(401).send({ error: 'not_signed_in' });
  }
  // Partner API tokens share the signing key: they must never pass as a user session.
  const claims = req.user as { sub?: string; typ?: string };
  if (!claims.sub || claims.typ) return reply.code(401).send({ error: 'not_signed_in' });
  // Beta: an account waiting for approval can only see itself, sign out or delete itself.
  if (!PENDING_ALLOWED.has(`${req.method} ${req.routeOptions.url}`) && await pendingForSession(claims.sub)) {
    return reply.code(403).send({ error: 'pending_approval', message: 'Your account is waiting for approval. We’ll email you as soon as it’s ready.' });
  }
}
// Redeeming a gift approves the account (a paid gift is the team's yes); joining a family is recorded meanwhile.
const PENDING_ALLOWED = new Set(['GET /me', 'POST /auth/logout', 'DELETE /me', 'POST /gifts/redeem', 'POST /family-invites/:token/accept']);

/** The i-person `id`, if it belongs to the signed-in user. */
export async function ownIperson(deps: AppDeps, req: FastifyRequest, id: string) {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [row] = await deps.db.select().from(ipersons)
    .where(and(eq(ipersons.id, id), eq(ipersons.userId, req.user.sub)));
  return row;
}

export function setSession(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', maxAge: 30 * 86_400,
  });
}

export async function authRoutes(app: FastifyInstance, deps: AppDeps) {
  const publicUser = (u: typeof users.$inferSelect) =>
    ({
      id: u.id, email: u.email, name: u.name, locale: u.locale, timezone: u.timezone, phone: u.phoneE164,
      ai_credit_usd: microsToUsd(u.aiCreditMicros), gender: u.gender, age_range: u.ageRange,
      // New users, and users who accepted an older consent text, must accept the current one.
      consent_required: u.consentVersion !== CONSENT_VERSION,
      selfie_consent: Boolean(u.selfieConsentAt), verified: Boolean(u.phoneE164),
      country: u.country ?? u.phoneCountry ?? u.signupCountry, currency: u.currency,
      setup_step: u.setupStep, onboarded: Boolean(u.onboardedAt), has_password: Boolean(u.passwordHash),
      account_kind: u.accountKind, pending_approval: Boolean(u.pendingApprovalAt),
      show_simulations: showSimulations(),
    });

  const tooMany = (reply: FastifyReply) => reply.code(429).send({ error: 'rate_limited', message: 'Too many attempts. Please wait a few minutes.' });

  app.post('/auth/register', async (req, reply) => {
    if (limited(`register:${req.ip}`, 5, HOUR)) return tooMany(reply);
    const body = Register.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const [exists] = await deps.db.select({ id: users.id }).from(users).where(eq(users.email, body.data.email));
    if (exists) return reply.code(409).send({ error: 'email_taken' });
    // Country allowlist (Part C): unknown or other countries need an invite code or a bypass email.
    const country = await deps.geo(req.ip, req.headers);
    let decision = await signupDecision(deps.db, { email: body.data.email, country, inviteCode: body.data.invite_code });
    // Personal invite links pass the country gate only if the admin allows it (default: waitlist).
    if (!decision.allowed && await joinBypassesCountry(deps.db, body.data.join_token)) decision = { allowed: true, via: 'invite' };
    if (!decision.allowed) return reply.code(403).send({ error: 'country_not_allowed', country });
    const accountKind = decision.judge ? 'judge' : 'user';
    const [user] = await deps.db.insert(users).values({
      email: body.data.email, name: body.data.name, passwordHash: await hashPassword(body.data.password),
      aiCreditMicros: usdToMicros((await runtimeSettings(deps.db)).freeCreditUsd),
      signupCountry: country,
      inviteCode: decision.via === 'invite' ? (body.data.invite_code?.trim().toUpperCase() || 'JOIN-LINK') : null,
      accountKind, pendingApprovalAt: await approvalFor(deps.db, { email: body.data.email, accountKind }),
      cohort: decision.cohort ?? null,
    }).returning();
    await notifyNewAccount(deps, user!, 'email and password', req.log);
    if (body.data.join_token) await acceptInvite(deps.db, body.data.join_token, user!.id).catch(() => false);
    setSession(reply, await reply.jwtSign({ sub: user!.id }, { expiresIn: '30d' }));
    return { user: publicUser(user!) };
  });

  app.post('/auth/login', async (req, reply) => {
    const body = Login.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    if (limited(`login-ip:${req.ip}`, 20, 15 * MIN) || limited(`login:${body.data.email}`, 10, 15 * MIN)) return tooMany(reply);
    const [user] = await deps.db.select().from(users).where(eq(users.email, body.data.email));
    if (!user || !(await verifyPassword(body.data.password, user.passwordHash))) {
      return reply.code(401).send({ error: 'wrong_email_or_password' });
    }
    if (user.suspendedAt) return reply.code(403).send({ error: 'account_suspended', message: 'This account is suspended. Contact contact@i-persons.com.' });
    const decision = await loginDecision(deps.db, user, await deps.geo(req.ip, req.headers));
    if (!decision.allowed) return reply.code(403).send({ error: 'country_not_allowed', country: decision.country });
    setSession(reply, await reply.jwtSign({ sub: user.id }, { expiresIn: '30d' }));
    return { user: publicUser(user) };
  });

  // The sign-up page asks first, to show "coming soon" before anyone types a password.
  app.get('/auth/country', async (req) => {
    const country = await deps.geo(req.ip, req.headers);
    const s = await countrySettings(deps.db);
    return { country, allowed: countryAllowed(s, country) };
  });

  app.post('/waitlist', async (req, reply) => {
    if (limited(`waitlist:${req.ip}`, 5, HOUR)) return tooMany(reply);
    const body = z.object({
      email: z.email().transform((e) => e.toLowerCase()),
      name: z.string().trim().max(80).optional(),
      consent: z.literal(true),
      /** Impact §9: the share link code this person came from. */
      ref: z.string().trim().max(20).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const country = await deps.geo(req.ip, req.headers);
    const [sharer] = body.data.ref ? await deps.db.select({ code: waitlist.shareCode }).from(waitlist).where(eq(waitlist.shareCode, body.data.ref)) : [];
    await deps.db.insert(waitlist).values({
      email: body.data.email, name: body.data.name, country, consentAt: new Date(), shareCode: randomBytes(6).toString('base64url'), referredBy: sharer?.code ?? null,
    }).onConflictDoNothing();
    const [mine] = await deps.db.select({ code: waitlist.shareCode }).from(waitlist).where(and(eq(waitlist.email, body.data.email), country ? eq(waitlist.country, country) : isNull(waitlist.country)));
    // Share card: a link that counts the people who join the waitlist through it.
    const share_link = mine?.code ? `${config.PUBLIC_URL}/signup?wl=${mine.code}` : config.PUBLIC_URL;
    return { ok: true, country, share_link, share_text: 'I’m waiting for i-persons: a digital twin that acts for you, never without your yes. Join the waitlist:' };
  });

  // Impact §9: the landing page's optional line ("People in <n> countries are waiting for i-persons").
  app.get('/waitlist/summary', async () => {
    if (!(await runtimeSettings(deps.db)).showWaitlistLine) return { countries: null };
    const [r] = await deps.db.select({ n: sql<number>`count(distinct ${waitlist.country})::int` }).from(waitlist).where(isNotNull(waitlist.country));
    return { countries: r?.n ?? 0 };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { preHandler: requireUser }, async (req, reply) => {
    const [user] = await deps.db.select().from(users).where(eq(users.id, req.user.sub));
    if (!user) return reply.code(401).send({ error: 'not_signed_in' });
    const [ip] = await deps.db.select().from(ipersons).where(eq(ipersons.userId, user.id));
    return { user: publicUser(user), iperson: ip ?? null };
  });

  // First onboarding screen (and My twin): gender, age range, consent. Adults only, by design.
  app.patch('/me/profile', { preHandler: requireUser }, async (req, reply) => {
    const body = z.object({
      gender: z.enum(GENDERS.map((g) => g.id) as [Gender, ...Gender[]]).optional(),
      age_range: z.enum(AGE_RANGES).optional(),
      consent_version: z.literal(CONSENT_VERSION).optional(),
      locale: z.enum(LANGUAGES.map((l) => l.id) as [string, ...string[]]).optional(),
      country: z.string().regex(/^[A-Z]{2}$/).optional(),
      currency: z.enum(CURRENCIES).optional(),
      timezone: z.string().min(3).max(60).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const { gender, age_range, consent_version, locale, country, currency, timezone } = body.data;
    const [user] = await deps.db.update(users).set({
      gender, ageRange: age_range, locale, country, currency, timezone,
      ...(consent_version ? { consentVersion: consent_version, consentAt: new Date() } : {}),
    }).where(eq(users.id, req.user.sub)).returning();
    if (!user) return reply.code(401).send({ error: 'not_signed_in' });
    return { user: publicUser(user) };
  });

  // First-run setup progress: the step reached (so a reload resumes there), and the finish.
  app.patch('/me/setup', { preHandler: requireUser }, async (req, reply) => {
    const body = z.object({ step: z.enum(SETUP_STEPS).optional(), done: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const [user] = await deps.db.update(users).set({
      setupStep: body.data.step, ...(body.data.done ? { onboardedAt: new Date() } : {}),
    }).where(eq(users.id, req.user.sub)).returning();
    if (!user) return reply.code(401).send({ error: 'not_signed_in' });
    return { user: publicUser(user) };
  });

  app.get('/me/credit', { preHandler: requireUser }, async (req) => ({ ...(await creditSummary(deps.db, req.user.sub)), billing: deps.billing }));

  // Account deletion (privacy policy / Meta data deletion). Every table cascades from users;
  // uploaded selfies are named after the i-person id, so they go too.
  app.delete('/me', { preHandler: requireUser }, async (req, reply) => {
    const body = z.object({ password: z.string().optional(), confirm: z.string().optional() }).safeParse(req.body);
    const [user] = await deps.db.select().from(users).where(eq(users.id, req.user.sub));
    if (!user) return reply.code(401).send({ error: 'not_signed_in' });
    // DEMO: the shared demo accounts' password is public (README), so nobody may delete them.
    if (user.accountKind === 'demo') return reply.code(403).send({ error: 'demo_account', message: 'Demo accounts are shared and can’t be deleted.' });
    // Accounts made with Google/Microsoft/Facebook have no password: they type DELETE instead.
    const ok = !body.success ? false
      : user.passwordHash ? Boolean(body.data.password) && await verifyPassword(body.data.password!, user.passwordHash)
      : body.data.confirm === 'DELETE';
    if (!ok) {
      return reply.code(403).send({ error: 'wrong_password' });
    }
    const owned = await deps.db.select({ id: ipersons.id }).from(ipersons).where(eq(ipersons.userId, user.id));
    await deps.db.delete(users).where(eq(users.id, user.id));
    const files = await readdir(config.UPLOAD_DIR).catch(() => [] as string[]);
    await Promise.all(files.filter((f) => owned.some((ip) => f.startsWith(`${ip.id}-`)))
      .map((f) => rm(join(config.UPLOAD_DIR, f), { force: true })));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
