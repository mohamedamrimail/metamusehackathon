import type { FastifyInstance, FastifyRequest } from 'fastify';
import { allowlistActive, config } from '../config.ts';
import { runtimeSettings } from '../lib/settings.ts';
import { metaKeyCheck } from '../meta/key-check.ts';
import type { AppDeps } from './deps.ts';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.ts';
import { clearCalls, onCall, recentCalls } from '../lib/call-log.ts';
import { SESSION_COOKIE } from './auth.ts';

/** True when PUBLIC_URL is a public HTTPS address (glasses and OAuth callbacks need one). */
export const publicHttps = (): boolean => {
  try {
    const u = new URL(config.PUBLIC_URL);
    return u.protocol === 'https:' && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname);
  } catch {
    return false;
  }
};

/**
 * GET /features — which optional integrations are configured, so the web shows "not configured" instead of
 * failing, plus the Meta key status for the demo-mode banner. Public: it reveals no secrets, only on/off.
 */
export async function featureRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/features', async () => {
    const key = metaKeyCheck();
    return {
      meta: { status: key.status, message: key.message },
      demo: deps.demoMode,
      beta_approval: (await runtimeSettings(deps.db)).requireApproval,
      country_allowlist: allowlistActive(),
      whatsapp: Boolean(deps.wa),
      glasses: publicHttps(),
      email: Boolean(config.SMTP_URL),
      google: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
      microsoft: Boolean(config.MS_CLIENT_ID && config.MS_CLIENT_SECRET),
      facebook: Boolean(config.FACEBOOK_APP_ID && config.FACEBOOK_APP_SECRET),
      scenes: Boolean(config.PEXELS_API_KEY),
      avatar_ai: Boolean(deps.avatar),
      calls_panel: (await runtimeSettings(deps.db)).showCallsPanel,
    };
  });
}

/**
 * DEMO: GET /demo/calls — the Meta AI calls panel's live feed (server-sent events): the last calls, then each new one.
 * Demo accounts only; they see the calls of every demo account (the demo family), never a real user's.
 */
export async function callLogRoutes(app: FastifyInstance, deps: AppDeps) {
  const demoViewer = async (req: FastifyRequest) => {
    let sub: string | undefined;
    try { sub = app.jwt.verify<{ sub: string }>(req.cookies[SESSION_COOKIE] ?? '').sub; } catch { /* signed out */ }
    const [u] = sub ? await deps.db.select({ kind: users.accountKind }).from(users).where(eq(users.id, sub)) : [];
    return u?.kind === 'demo' && (await runtimeSettings(deps.db)).showCallsPanel;
  };
  app.post('/demo/calls/clear', async (req, reply) => {
    if (!(await demoViewer(req))) return reply.code(404).send({ error: 'not_found' });
    clearCalls();
    return { ok: true };
  });
  app.get('/demo/calls', async (req, reply) => {
    if (!(await demoViewer(req))) return reply.code(404).send({ error: 'not_found' });
    reply.hijack();
    const res = reply.raw;
    // nginx must not buffer the stream.
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    for (const e of recentCalls(40)) write(e);
    const off = onCall(write);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => { off(); clearInterval(ping); });
  });
}
