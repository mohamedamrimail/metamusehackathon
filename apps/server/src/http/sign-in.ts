import { eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { usdToMicros } from '../billing/credits.ts';
import { config } from '../config.ts';
import { users } from '../db/schema.ts';
import { loginDecision, signupDecision } from '../geo/countries.ts';
import { approvalFor, notifyNewAccount } from '../lib/approval.ts';
import { HOUR, limited } from '../lib/ratelimit.ts';
import { runtimeSettings } from '../lib/settings.ts';
import type { AppDeps } from './deps.ts';
import { setSession } from './auth.ts';
import { redeemMagicLink } from '../channels/guest.ts';
import { refreshIdentifiers } from '../twins/identifiers.ts';
import { acceptInvite, joinBypassesCountry } from '../twins/invites.ts';

// "Continue with Google / Microsoft / Facebook": OpenID-style sign-in with only name + email.
// Separate from the mailbox OAuth (mail.ts), which asks for read access to mail and needs a session.

export const SIGN_IN_PROVIDERS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    clientId: () => config.GOOGLE_CLIENT_ID,
    clientSecret: () => config.GOOGLE_CLIENT_SECRET,
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email profile User.Read',
    clientId: () => config.MS_CLIENT_ID,
    clientSecret: () => config.MS_CLIENT_SECRET,
  },
  facebook: {
    authorize: 'https://www.facebook.com/v23.0/dialog/oauth',
    token: 'https://graph.facebook.com/v23.0/oauth/access_token',
    scope: 'email public_profile',
    clientId: () => config.FACEBOOK_APP_ID,
    clientSecret: () => config.FACEBOOK_APP_SECRET,
  },
} as const;
export type SignInProvider = keyof typeof SIGN_IN_PROVIDERS;

export const signInRedirectUri = (p: SignInProvider) => `${config.PUBLIC_URL}/api/auth/oauth/${p}/callback`;
const configured = (p: SignInProvider) => Boolean(SIGN_IN_PROVIDERS[p].clientId() && SIGN_IN_PROVIDERS[p].clientSecret());

interface Identity { email: string; name: string }

/** The verified email and name for an access token (id_token claims come from the token endpoint over TLS). */
export async function identityFrom(p: SignInProvider, token: { access_token: string; id_token?: string }): Promise<Identity | null> {
  if (p === 'facebook') {
    const res = await fetch(`https://graph.facebook.com/v23.0/me?fields=name,email&access_token=${encodeURIComponent(token.access_token)}`, { signal: AbortSignal.timeout(10_000) });
    const me = (await res.json()) as { name?: string; email?: string };
    return me.email ? { email: me.email.toLowerCase(), name: me.name ?? me.email.split('@')[0]! } : null;
  }
  const claims = token.id_token ? JSON.parse(Buffer.from(token.id_token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown> : {};
  // Google says whether the address is verified; Microsoft personal and work accounts own theirs.
  if (p === 'google' && claims.email_verified === false) return null;
  const email = String(claims.email ?? claims.preferred_username ?? '').toLowerCase();
  if (!z.email().safeParse(email).success) return null;
  return { email, name: String(claims.given_name ?? claims.name ?? email.split('@')[0]) };
}

export async function signInRoutes(app: FastifyInstance, deps: AppDeps) {
  // HACKATHON: pending states in memory for 10 minutes; a restart means "try again".
  const pending = new Map<string, { provider: SignInProvider; verifier: string; invite?: string; join?: string; expires: number }>();
  const providerOf = (v: string) => z.enum(['google', 'microsoft', 'facebook']).safeParse(v);
  const back = (error: string) => `/login?error=${error}`;

  // Impact §3: a WhatsApp guest's single-use, 15-minute link to finish their twin on the web.
  app.get<{ Params: { token: string } }>('/auth/magic/:token', async (req, reply) => {
    if (limited(`magic:${req.ip}`, 20, HOUR)) return reply.redirect(back('rate_limited'));
    const userId = await redeemMagicLink(deps, req.params.token);
    if (!userId) return reply.redirect(back('expired'));
    setSession(reply, await reply.jwtSign({ sub: userId }, { expiresIn: '30d' }));
    return reply.redirect('/onboarding');
  });

  app.get('/auth/providers', async () => ({
    google: configured('google'), microsoft: configured('microsoft'), facebook: configured('facebook'),
  }));

  app.get<{ Params: { provider: string }; Querystring: { invite?: string; join?: string } }>('/auth/oauth/:provider/start', async (req, reply) => {
    const p = providerOf(req.params.provider);
    if (!p.success || !configured(p.data)) return reply.redirect(back('provider_unavailable'));
    if (limited(`oauth-start:${req.ip}`, 30, HOUR)) return reply.redirect(back('rate_limited'));
    for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    pending.set(state, { provider: p.data, verifier, invite: req.query.invite?.trim().slice(0, 40) || undefined, join: req.query.join?.trim().slice(0, 64) || undefined, expires: Date.now() + 10 * 60_000 });
    const cfg = SIGN_IN_PROVIDERS[p.data];
    const q = new URLSearchParams({
      client_id: cfg.clientId()!, redirect_uri: signInRedirectUri(p.data), response_type: 'code', scope: cfg.scope, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      ...(p.data === 'google' ? { prompt: 'select_account' } : p.data === 'microsoft' ? { prompt: 'select_account', response_mode: 'query' } : {}),
    });
    // Business-type Meta apps only offer Facebook Login for Business, which takes a configuration id, not scopes.
    if (p.data === 'facebook' && config.FACEBOOK_LOGIN_CONFIG_ID) { q.delete('scope'); q.set('config_id', config.FACEBOOK_LOGIN_CONFIG_ID); }
    return reply.redirect(`${cfg.authorize}?${q}`);
  });

  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>('/auth/oauth/:provider/callback', async (req, reply) => {
    const st = pending.get(req.query.state ?? '');
    if (st) pending.delete(req.query.state!); // single use
    if (!st || st.expires < Date.now() || st.provider !== req.params.provider) return reply.redirect(back('expired'));
    if (req.query.error || !req.query.code) return reply.redirect(back('cancelled'));
    const cfg = SIGN_IN_PROVIDERS[st.provider];
    let identity: Identity | null = null;
    try {
      const res = await fetch(cfg.token, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15_000),
        body: new URLSearchParams({
          client_id: cfg.clientId()!, client_secret: cfg.clientSecret()!, code: req.query.code, grant_type: 'authorization_code',
          redirect_uri: signInRedirectUri(st.provider), code_verifier: st.verifier,
        }),
      });
      const token = (await res.json()) as { access_token?: string; id_token?: string };
      if (res.ok && token.access_token) identity = await identityFrom(st.provider, { access_token: token.access_token, id_token: token.id_token });
    } catch (err) {
      req.log.warn({ err, provider: st.provider }, 'sign-in token exchange failed');
    }
    if (!identity) return reply.redirect(back('no_email'));

    const country = await deps.geo(req.ip, req.headers);
    let [user] = await deps.db.select().from(users).where(eq(users.email, identity.email));
    if (user) {
      if (user.suspendedAt) return reply.redirect(back('account_suspended'));
      if (!(await loginDecision(deps.db, user, country)).allowed) return reply.redirect(back('country_not_allowed'));
    } else {
      let decision = await signupDecision(deps.db, { email: identity.email, country, inviteCode: st.invite });
      if (!decision.allowed && await joinBypassesCountry(deps.db, st.join)) decision = { allowed: true, via: 'invite' };
      if (!decision.allowed) return reply.redirect(`/signup?error=country_not_allowed`);
      const accountKind = decision.judge ? 'judge' : 'user';
      [user] = await deps.db.insert(users).values({
        email: identity.email, name: identity.name.slice(0, 80), passwordHash: null,
        aiCreditMicros: usdToMicros((await runtimeSettings(deps.db)).freeCreditUsd),
        signupCountry: country, inviteCode: decision.via === 'invite' ? (st.invite?.toUpperCase() || 'JOIN-LINK') : null,
        accountKind, pendingApprovalAt: await approvalFor(deps.db, { email: identity.email, accountKind }),
        cohort: decision.cohort ?? null,
      }).returning();
      await notifyNewAccount(deps, user!, st.provider, req.log);
      if (st.join) await acceptInvite(deps.db, st.join, user!.id).catch(() => false);
    }
    // The provider proved this address: it becomes matchable for contacts (twin-to-twin §1).
    if (!user!.emailVerifiedAt) {
      await deps.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user!.id));
      await refreshIdentifiers(deps.db, user!.id).catch((err) => req.log.warn({ err }, 'identifier refresh failed'));
    }
    setSession(reply, await reply.jwtSign({ sub: user!.id }, { expiresIn: '30d' }));
    return reply.redirect(user!.onboardedAt ? '/talk' : '/onboarding');
  });
}
