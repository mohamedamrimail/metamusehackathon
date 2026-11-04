import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyReply } from 'fastify';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from './agent/runtime.ts';
import { webChannel } from './channels/web.ts';
import { whatsappChannel } from './channels/whatsapp.ts';
import { createWaSender, sendToOwner } from './channels/whatsapp-client.ts';
import { allowlistActive, config } from './config.ts';
import { createDb, type Db } from './db/client.ts';
import { signInRoutes } from './http/sign-in.ts';
import { appIconRoutes } from './http/app-icon.ts';
import { consoleRoutes } from './http/console.ts';
import { feedbackRoutes } from './http/feedback.ts';
import { impactRoutes } from './http/impact.ts';
import { growthRoutes } from './http/growth.ts';
import { setupRoutes } from './http/setup.ts';
import { authRoutes, SESSION_COOKIE } from './http/auth.ts';
import { setApprovalDb } from './lib/approval.ts';
import { pricingRoutes } from './http/pricing.ts';
import { glassesRoutes } from './http/glasses.ts';
import { callLogRoutes, featureRoutes } from './http/features.ts';
import { loggedLlm, setCallLogDb, withCall } from './lib/call-log.ts';
import { loggedWa } from './channels/whatsapp-client.ts';
import { checkMetaKey, keyBanner } from './meta/key-check.ts';
import { twinPageHtml } from './http/seo.ts';
import { backfillIdentifiers } from './twins/jobs.ts';
import type { AppDeps } from './http/deps.ts';
import { ipersonRoutes } from './http/ipersons.ts';
import { EventBus } from './lib/bus.ts';
import { McpRegistry } from './mcp/client.ts';
import { DemoLlm } from './meta/demo-llm.ts';
import { metaAvatar } from './meta/image.ts';
import { MetaLlm, type Llm } from './meta/llm.ts';
import { metaRealtimeStt } from './meta/stt.ts';
import { presetScene, SCENE_PRESETS } from './scenes/scenes.ts';
import { maxmindGeo, updateGeoDb } from './geo/countries.ts';
import { adminRoutes } from './http/admin.ts';
import { storeRoutes } from './http/store.ts';
import { mailRoutes } from './http/mail.ts';
import { partnerApiRoutes } from './http/partner-api.ts';
import { partnerRoutes } from './http/partners.ts';
import { orgRoutes } from './http/org.ts';
import { publicRoutes } from './http/public.ts';
import { contactRoutes, inviteRoutes } from './http/contacts.ts';
import { twinsAdminRoutes } from './http/twins-admin.ts';
import { fulfilRequest, settleRequest } from './partners/requests.ts';
import { deliverDue } from './partners/webhooks.ts';
import { partnerRequestHandler } from './agent/tools/partner_request.ts';
import { visitorRequestHandler } from './agent/tools/visitor_request.ts';
import { twinRequestHandler } from './agent/tools/twin_request.ts';
import { fulfilTwinRequest, settleTwinRequest } from './twins/handlers.ts';
import { planHandler } from './agent/tools/plan_with_contacts.ts';
import { planTick, startPlan } from './twins/plans.ts';
import { twinDeps } from './twins/agent-support.ts';
import { checkoutSender } from './agent/tools/prepare_checkout.ts';
import { eq } from 'drizzle-orm';
import { ipersons, users } from './db/schema.ts';
import { fulfilVisitorRequest, settleVisitorRequest } from './public/visitor.ts';
import { scanOpportunities, startScheduler } from './jobs/opportunities.ts';

const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
/** First path segments that are web-app pages (keep in sync with apps/web/src/App.tsx routes). */
const SPA_PAGES = new Set(['', 'login', 'signup', 'onboarding', 'talk', 'twin', 'activity', 'store', 'admin', 'insights', 'developers', 'org', 'console', 'impact-method', 'contacts', 'join', 's', 'pricing', 'gift', 'redeem', 'family', 'demo', 'glasses']); // DEMO: 'demo' = the neutral demo hand-off pages (/demo/stay, /demo/fly, /demo/shop)

export function createDeps(db: Db, overrides: Partial<AppDeps> = {}): AppDeps {
  const demoMode = !config.META_API_KEY;
  // DEMO: every model call is logged for the Meta AI calls panel (demo accounts only; lib/call-log.ts).
  const llm: Llm = loggedLlm(overrides.llm ?? (demoMode ? new DemoLlm() : new MetaLlm()), demoMode ? 'no META_API_KEY: rule-based stand-in' : undefined);
  const mcp = new McpRegistry(db);
  // eslint-disable-next-line prefer-const -- the runtime's hook needs the finished deps
  let deps: AppDeps;
  deps = {
    db,
    llm,
    mcp,
    runtime: new AgentRuntime({
      db, llm, extraTools: (id) => deps.mcp.toolsFor(id), credits: demoMode ? undefined : { model: config.META_LLM_MODEL },
      onSettled: async (action) => { await settleRequest(deps, action); await settleVisitorRequest(deps, action); await settleTwinRequest(deps, action); },
      whatsapp: async (to, text, image) => {
        if (!deps.wa) throw new Error('WhatsApp is not configured');
        await sendToOwner(deps.wa, to, text, { name: config.WA_UPDATE_TEMPLATE, lang: config.WA_TEMPLATE_LANG }, image);
      },
    }),
    bus: new EventBus(),
    stt: demoMode ? undefined : metaRealtimeStt,
    avatar: demoMode ? undefined : metaAvatar,
    wa: loggedWa(createWaSender()),
    demoMode,
    billing: !demoMode,
    // HACKATHON: if nginx ever sits behind Cloudflare, prefer its CF-IPCountry header here.
    geo: maxmindGeo,
    ...overrides,
  };
  partnerRequestHandler.fulfil = (requestId) => fulfilRequest(deps, requestId);
  visitorRequestHandler.fulfil = (args) => fulfilVisitorRequest(deps, args);
  twinRequestHandler.fulfil = (ctx, args) => fulfilTwinRequest(deps, ctx, args);
  planHandler.start = (ctx, userId, args) => startPlan(deps, userId, args, ctx.now);
  twinDeps.deps = deps;
  // Hand-off links go out on the web (live sessions) and WhatsApp.
  checkoutSender.send = async (ipersonId, text) => {
    deps.bus.publish(ipersonId, { type: 'agent.text', text, final: true, mood: 'happy' });
    const [u] = await db.select({ phone: users.phoneE164 }).from(ipersons).innerJoin(users, eq(users.id, ipersons.userId)).where(eq(ipersons.id, ipersonId));
    if (deps.wa && u?.phone) await deps.wa.sendText(u.phone.replace(/^\+/, ''), text).catch(() => {});
  };
  return deps;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: { level: config.NODE_ENV === 'test' ? 'silent' : 'info' },
    // Only nginx on this machine is a trusted proxy: req.ip is then the address nginx saw, never one a client
    // put into X-Forwarded-For itself (that would bypass the country gate and per-IP rate limits).
    trustProxy: ['127.0.0.1', '::1'],
    // nginx strips /api; strip it here too so local dev and direct calls hit the same routes.
    // A browser page load of one of the web app's pages always gets the app, even when an API route
    // shares the path (the /store page vs the /store API). Everything else (OAuth callbacks, API) is API.
    rewriteUrl: (req) => {
      const url = req.url ?? '/';
      if (url.startsWith('/api/')) return url.slice(4);
      const first = url.split(/[/?#]/)[1] ?? '';
      const page = req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html') && (SPA_PAGES.has(first) || /^@[a-z0-9-]{3,30}$/i.test(first));
      return page && existsSync(WEB_DIST) ? `/__page${url}` : url;
    },
  });
  if (!config.JWT_SECRET && config.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production');

  app.register(cookie);
  // DEMO: the signed-in user owns the Meta calls made while serving the request (Meta AI calls panel).
  setCallLogDb(deps.db);
  app.addHook('onRequest', (req, _reply, done) => {
    let userId: string | undefined;
    const token = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
    try { userId = token ? app.jwt.verify<{ sub: string }>(decodeURIComponent(token)).sub : undefined; } catch { /* signed out */ }
    withCall({ userId }, done);
  });
  app.register(jwt, { secret: config.JWT_SECRET ?? 'dev-only-secret', cookie: { cookieName: SESSION_COOKIE, signed: false } });
  app.register(multipart);
  app.register(websocket, { options: { maxPayload: 1 << 20 } });

  app.get('/health', async () => {
    await deps.db.execute('select 1');
    return { ok: true, demo: deps.demoMode };
  });

  setApprovalDb(deps.db);
  app.register(async (scope) => authRoutes(scope, deps));
  app.register(async (scope) => signInRoutes(scope, deps));
  app.register(async (scope) => setupRoutes(scope, deps));
  app.register(async (scope) => appIconRoutes(scope, deps));
  app.register(async (scope) => ipersonRoutes(scope, deps));
  app.register(async (scope) => adminRoutes(scope, deps));
  app.register(async (scope) => storeRoutes(scope, deps));
  app.register(async (scope) => mailRoutes(scope, deps));
  app.register(async (scope) => partnerApiRoutes(scope, deps));
  app.register(async (scope) => partnerRoutes(scope, deps));
  app.register(async (scope) => orgRoutes(scope, deps));
  app.register(async (scope) => consoleRoutes(scope, deps));
  app.register(async (scope) => feedbackRoutes(scope, deps));
  app.register(async (scope) => impactRoutes(scope, deps));
  app.register(async (scope) => growthRoutes(scope, deps));
  app.register(async (scope) => pricingRoutes(scope, deps));
  app.register(async (scope) => glassesRoutes(scope, deps));
  app.register(async (scope) => featureRoutes(scope, deps));
  app.register(async (scope) => callLogRoutes(scope, deps));
  app.register(async (scope) => publicRoutes(scope, deps));
  app.register(async (scope) => contactRoutes(scope, deps));
  app.register(async (scope) => inviteRoutes(scope, deps));
  app.register(async (scope) => twinsAdminRoutes(scope, deps));
  app.register(async (scope) => webChannel(scope, deps));
  app.register(async (scope) => whatsappChannel(scope, deps));

  // The built web app (apps/web/dist), with client-side routes falling back to index.html.
  if (existsSync(WEB_DIST)) {
    app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
    // The page must never be cached (phones would keep an old build); its hashed assets can be.
    const page = (reply: FastifyReply) => reply.header('Cache-Control', 'no-cache').sendFile('index.html', { cacheControl: false });
    app.get('/__page/*', async (req, reply) => {
      // A public twin's page carries that twin's link preview (name, bio, avatar).
      const html = await twinPageHtml(deps, WEB_DIST, req.url.slice('/__page'.length)).catch(() => undefined);
      return html ? reply.type('text/html').header('Cache-Control', 'no-cache').send(html) : page(reply);
    });
    app.get('/__page', (_req, reply) => page(reply));
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/ws/') && req.headers.accept?.includes('text/html')) {
        return page(reply);
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Meta key first: a missing or rejected key starts the app in demo mode, with a banner in the log and on the web.
  const key = await checkMetaKey();
  console.log(keyBanner(key));
  // HACKATHON: a rejected key is dropped so createDeps picks the demo model instead of failing on every call.
  if (key.status === 'invalid') config.META_API_KEY = undefined;
  const { db } = createDb();
  const deps = createDeps(db);
  const app = buildApp(deps);
  await app.listen({ port: config.PORT, host: config.HOST });
  console.log(`\ni-persons is running: ${config.APP_URL}\n`);
  const stopScheduler = startScheduler(deps, app.log);
  void backfillIdentifiers(deps).then((n) => n && app.log.info({ accounts: n }, 'contact identifiers backfilled'), (err) => app.log.warn({ err }, 'identifier backfill failed'));
  // Partner API: deliver webhooks, expire stale approval cards (→ request.expired).
  const partnerTimers = [
    setInterval(() => void deliverDue(db).catch((err) => app.log.warn({ err }, 'webhook delivery failed')), 15_000),
    setInterval(() => void deps.runtime.expireStale().catch((err) => app.log.warn({ err }, 'expiry failed')), 60_000),
    // Twin-to-twin plans: 48 h expiry, one reminder after 24 h.
    setInterval(() => void planTick(deps).catch((err) => app.log.warn({ err }, 'plan tick failed')), 5 * 60_000),
  ];
  for (const t of partnerTimers) t.unref();
  // Country database (only when the allowlist is on): fetched now if missing, refreshed monthly (MaxMind GeoLite2).
  if (allowlistActive()) {
    const refreshGeo = () => updateGeoDb().catch((err) => app.log.warn({ err }, 'geo database update failed'));
    void refreshGeo();
    const geoTimer = setInterval(refreshGeo, 86_400_000);
    geoTimer.unref();
  }
  // Scene presets are downloaded once (Pexels) so Smart scenes can switch instantly.
  if (config.PEXELS_API_KEY) {
    void Promise.all(SCENE_PRESETS.map((p) => presetScene(p.id))).catch((err) => app.log.warn({ err }, 'scene presets failed'));
  }
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, async () => {
      await stopScheduler();
      await app.close();
      process.exit(0);
    });
  }
  app.log.info(deps.demoMode ? 'DEMO MODE: no META_API_KEY, using the rule-based demo model' : `LLM: ${config.META_LLM_MODEL}`);
}
