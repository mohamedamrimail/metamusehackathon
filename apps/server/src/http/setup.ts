import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INTEREST_QUESTIONS, isDemoAccount, isDemoProvider, LINK_KINDS, providerById, suggestTwinNames } from '@ipersons/shared';
import { learnFromText, pdfText, readLink } from '../agent/links.ts';
import { upsertFact } from '../agent/memory.ts';
import { hasCredit, meteredLlm } from '../billing/credits.ts';
import { config } from '../config.ts';
import { ipersonRules, profileLinks, sourcePrefs, users } from '../db/schema.ts';
import { limited, MIN } from '../lib/ratelimit.ts';
import { ownIperson, requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

// First-run setup (warm-up): name ideas, links to learn from, interests, rules, preferred sources,
// and the closing turn where the twin makes its first suggestion.

const SOCIAL_HOSTS = /(^|\.)(linkedin\.com|facebook\.com|fb\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com|threads\.net)$/i;

export async function setupRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  app.addHook('preHandler', requireUser);
  const notFound = (reply: { code(n: number): { send(b: unknown): unknown } }) => reply.code(404).send({ error: 'not_found' });
  const llmFor = (userId: string) => (deps.billing ? meteredLlm(deps.llm, db, userId, config.META_LLM_MODEL) : deps.llm);

  app.get('/me/twin-names', async (req) => {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, req.user.sub));
    return { names: suggestTwinNames(u?.name ?? '') };
  });

  // --- rules ---

  const RuleBody = z.object({ kind: z.enum(['do', 'dont']), text: z.string().trim().min(3).max(200) });

  app.get<{ Params: { id: string } }>('/ipersons/:id/rules', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    return { rules: await db.select().from(ipersonRules).where(and(eq(ipersonRules.ipersonId, ip.id), eq(ipersonRules.status, 'active'))).orderBy(asc(ipersonRules.createdAt)) };
  });

  app.post<{ Params: { id: string } }>('/ipersons/:id/rules', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const body = z.object({ rules: z.array(RuleBody).min(1).max(30), source: z.enum(['user', 'onboarding']).default('user') }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    const rows = await db.insert(ipersonRules).values(body.data.rules.map((r) => ({ ipersonId: ip.id, ...r, source: body.data.source }))).returning();
    return reply.code(201).send({ rules: rows });
  });

  app.patch<{ Params: { id: string; rule: string } }>('/ipersons/:id/rules/:rule', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip || !z.uuid().safeParse(req.params.rule).success) return notFound(reply);
    const body = z.object({ text: z.string().trim().min(3).max(200).optional(), active: z.boolean().optional(), kind: z.enum(['do', 'dont']).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    // Editing a learned or chat rule makes it the user's own.
    const [row] = await db.update(ipersonRules).set({ ...body.data, ...(body.data.text ? { source: 'user' as const } : {}) })
      .where(and(eq(ipersonRules.id, req.params.rule), eq(ipersonRules.ipersonId, ip.id))).returning();
    return row ? { rule: row } : notFound(reply);
  });

  app.delete<{ Params: { id: string; rule: string } }>('/ipersons/:id/rules/:rule', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip || !z.uuid().safeParse(req.params.rule).success) return notFound(reply);
    await db.delete(ipersonRules).where(and(eq(ipersonRules.id, req.params.rule), eq(ipersonRules.ipersonId, ip.id)));
    return { ok: true };
  });

  // --- links to learn from ---

  app.get<{ Params: { id: string } }>('/ipersons/:id/links', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    return { links: await db.select().from(profileLinks).where(eq(profileLinks.ipersonId, ip.id)).orderBy(asc(profileLinks.createdAt)) };
  });

  app.post<{ Params: { id: string } }>('/ipersons/:id/links', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const body = z.object({ kind: z.enum(LINK_KINDS), url: z.url({ protocol: /^https?$/ }).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'That doesn’t look like a web address.' });
    // Social networks are never fetched (no scraping): LinkedIn is pasted or uploaded as a PDF instead.
    if (SOCIAL_HOSTS.test(new URL(body.data.url).hostname)) {
      return reply.code(400).send({ error: 'social_network', message: 'Social profiles aren’t read from links. For LinkedIn, paste your About and experience or upload your profile PDF below.' });
    }
    if (limited(`links:${req.user.sub}`, 10, 10 * MIN)) return reply.code(429).send({ error: 'rate_limited' });
    if (deps.billing && !(await hasCredit(db, req.user.sub))) return reply.code(402).send({ error: 'no_credit' });
    const [link] = await db.insert(profileLinks).values({ ipersonId: ip.id, ...body.data })
      .onConflictDoUpdate({ target: [profileLinks.ipersonId, profileLinks.url], set: { status: 'pending', kind: body.data.kind } }).returning();
    // Read in the background; the page polls the list.
    void readLink(db, llmFor(req.user.sub), ip.id, link!).catch((err) => req.log.warn({ err }, 'link read failed'));
    return reply.code(201).send({ link });
  });

  // LinkedIn: the user pastes their About + experience, or uploads LinkedIn's own "Save to PDF".
  app.post<{ Params: { id: string } }>('/ipersons/:id/linkedin', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    if (limited(`linkedin:${req.user.sub}`, 5, 10 * MIN)) return reply.code(429).send({ error: 'rate_limited' });
    if (deps.billing && !(await hasCredit(db, req.user.sub))) return reply.code(402).send({ error: 'no_credit' });
    let text = '';
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: 5_000_000 } });
      const buf = file ? await file.toBuffer() : undefined;
      if (!buf || buf.subarray(0, 5).toString() !== '%PDF-') return reply.code(400).send({ error: 'invalid', message: 'Upload the PDF from LinkedIn’s “Save to PDF”.' });
      text = await pdfText(buf).catch(() => '');
    } else {
      text = z.object({ text: z.string().trim().max(20_000) }).safeParse(req.body).data?.text ?? '';
    }
    if (text.length < 40) return reply.code(400).send({ error: 'too_short', message: 'There’s too little text to learn from.' });
    try {
      // The user's own words about themselves: saved as facts they can edit right away.
      const learned = await learnFromText(db, llmFor(req.user.sub), ip.id, text, { label: 'your LinkedIn profile (pasted by you)' });
      return { learned: learned.facts, summary: learned.summary };
    } catch {
      return reply.code(422).send({ error: 'nothing_learned', message: 'Couldn’t learn anything from that text.' });
    }
  });

  app.delete<{ Params: { id: string; link: string } }>('/ipersons/:id/links/:link', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip || !z.uuid().safeParse(req.params.link).success) return notFound(reply);
    await db.delete(profileLinks).where(and(eq(profileLinks.id, req.params.link), eq(profileLinks.ipersonId, ip.id)));
    return { ok: true };
  });

  // --- interests (tapped answers become preference facts) ---

  app.post<{ Params: { id: string } }>('/ipersons/:id/interests', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const keys = INTEREST_QUESTIONS.map((q) => q.key) as [string, ...string[]];
    const body = z.object({ answers: z.partialRecord(z.enum(keys), z.array(z.string().trim().min(1).max(80)).max(12)) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    for (const [key, values] of Object.entries(body.data.answers)) {
      if (values?.length) await upsertFact(db, ip.id, { category: 'preference', key: `interest_${key}`, value: values.join(', '), source: 'onboarding', confidence: 0.9 });
    }
    return { ok: true };
  });

  // --- preferred sources, ranked per category ---

  app.get<{ Params: { id: string } }>('/ipersons/:id/sources', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    return { sources: await db.select().from(sourcePrefs).where(eq(sourcePrefs.ipersonId, ip.id)).orderBy(asc(sourcePrefs.category), asc(sourcePrefs.rank)) };
  });

  app.put<{ Params: { id: string } }>('/ipersons/:id/sources', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    const body = z.object({ providers: z.array(z.string()).max(60) }).safeParse(req.body);
    const picked = body.success ? body.data.providers.map(providerById) : [];
    if (!body.success || picked.some((p) => !p)) return reply.code(400).send({ error: 'invalid' });
    // DEMO: the neutral demo sources are for demo accounts only.
    const [me] = await db.select({ kind: users.accountKind }).from(users).where(eq(users.id, req.user.sub));
    if (!isDemoAccount(me?.kind) && picked.some((p) => isDemoProvider(p!.id))) return reply.code(400).send({ error: 'invalid' });
    // Rank = order of the list within each category.
    const rankIn: Record<string, number> = {};
    await db.transaction(async (tx) => {
      await tx.delete(sourcePrefs).where(eq(sourcePrefs.ipersonId, ip.id));
      if (picked.length) {
        await tx.insert(sourcePrefs).values(picked.map((p) => ({ ipersonId: ip.id, category: p!.category, provider: p!.id, rank: (rankIn[p!.category] = (rankIn[p!.category] ?? 0) + 1) })));
      }
    });
    return { ok: true };
  });

  // --- the end of setup: the twin's first suggestion ---

  app.post<{ Params: { id: string } }>('/ipersons/:id/warmup', async (req, reply) => {
    const ip = await ownIperson(deps, req, req.params.id);
    if (!ip) return notFound(reply);
    if (limited(`warmup:${req.user.sub}`, 3, 10 * MIN)) return reply.code(429).send({ error: 'rate_limited' });
    const conversationId = await deps.runtime.conversationFor(ip.id, 'web');
    const turn = await deps.runtime.handleNotice({
      ipersonId: ip.id, conversationId,
      text: 'The user just finished setting you up. Greet them warmly by first name in one short sentence, then make ONE concrete first suggestion '
        + 'that fits their interests, rules and preferred sources (use find_opportunities if it helps, and give the link if you have one). '
        + 'End by asking if they want more like it. Max 3 sentences.',
    });
    await db.update(users).set({ onboardedAt: new Date(), setupStep: 'warmup' }).where(eq(users.id, req.user.sub));
    return { reply: turn.reply, mood: turn.mood ?? 'happy' };
  });
}
