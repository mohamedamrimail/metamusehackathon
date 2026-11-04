import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decideMemory } from '../agent/memory.ts';
import { createGuest, greetUnknown, guestOverLimit, isGuest, magicLink, PENDING_GUEST, takeWaitingMessage, WEB_LINK } from './guest.ts';
import { runtimeSettings } from '../lib/settings.ts';
import { ActionError, NO_CREDIT_REPLY, type ActionRow } from '../agent/runtime.ts';
import { charge, hasCredit } from '../billing/credits.ts';
import { config } from '../config.ts';
import { HOUR, limited } from '../lib/ratelimit.ts';
import { isPending } from '../lib/approval.ts';
import { countryAllowed, countrySettings, phoneRegion } from '../geo/countries.ts';
import { ipersons, users } from '../db/schema.ts';
import { ownIperson, requireUser } from '../http/auth.ts';
import type { AppDeps } from '../http/deps.ts';
import { toWav16k } from '../lib/audio.ts';
import { transcribeWav } from '../meta/stt.ts';
import { publishDecision, publishTurn } from './events.ts';
import { refreshIdentifiers } from '../twins/identifiers.ts';
import { onPhoneVerified } from '../twins/hooks.ts';
import { blockFromCard } from '../twins/handlers.ts';

// WhatsApp channel: same agent runtime as the web, only input/output differ (SPEC: WhatsApp channel).

/** Meta's X-Hub-Signature-256 ("sha256=<hex>") over the raw body. */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const got = Buffer.from(header.slice(7), 'hex');
  const want = createHmac('sha256', secret).update(raw).digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

const Inbound = z.object({
  entry: z.array(z.object({
    changes: z.array(z.object({
      value: z.object({
        messages: z.array(z.object({
          id: z.string(),
          from: z.string(),
          type: z.string(),
          text: z.object({ body: z.string() }).optional(),
          audio: z.object({ id: z.string() }).optional(),
          interactive: z.object({ button_reply: z.object({ id: z.string() }).optional() }).optional(),
          button: z.object({ payload: z.string() }).optional(),
        })).optional(),
        contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).optional(),
        statuses: z.array(z.object({
          id: z.string(),
          status: z.string(),
          errors: z.array(z.object({ code: z.number(), title: z.string().optional() })).optional(),
        })).optional(),
      }),
    })),
  })),
});
type WaMessage = NonNullable<z.infer<typeof Inbound>['entry'][number]['changes'][number]['value']['messages']>[number];

// HACKATHON: in-memory link codes and dedupe; a restart forgets pending codes (they last 15 min anyway).
const linkCodes = new Map<string, { userId: string; expires: number }>();
const failedTries = new Map<string, { n: number; until: number }>();
const seen = new Set<string>();
const remember = (wamid: string) => {
  seen.add(wamid);
  if (seen.size > 5000) seen.delete(seen.values().next().value!);
};

const NOT_LINKED = 'Hi! This number is not linked to an i-person yet. Open i-persons.com → My twin → WhatsApp to link it.';

export async function whatsappChannel(app: FastifyInstance, deps: AppDeps) {
  // Raw body for the signature check.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get<{ Querystring: Record<string, string> }>('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query;
    if (q['hub.mode'] === 'subscribe' && config.WA_VERIFY_TOKEN && q['hub.verify_token'] === config.WA_VERIFY_TOKEN) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send({ error: 'forbidden' });
  });

  app.post('/webhooks/whatsapp', async (req, reply) => {
    const raw = req.body as Buffer;
    if (!config.WA_APP_SECRET || !verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, config.WA_APP_SECRET)) {
      return reply.code(401).send({ error: 'bad_signature' });
    }
    const parsed = Inbound.safeParse(JSON.parse(raw.toString('utf8')));
    // Ack first: Meta retries slow webhooks. Processing continues in the background.
    reply.code(200).send({ ok: true });
    if (!parsed.success) return;
    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        for (const msg of change.value.messages ?? []) {
          if (seen.has(msg.id)) continue;
          remember(msg.id);
          handleMessage(deps, msg, req.log, change.value.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name).catch((err) => req.log.error({ err }, 'whatsapp message failed'));
        }
        // Delivery reports: only failures are worth a log line (e.g. 131047 outside the 24 h window).
        for (const s of change.value.statuses ?? []) {
          if (s.status === 'failed') req.log.warn({ wamid: s.id, errors: s.errors }, 'whatsapp delivery failed');
        }
      }
    }
  });

  // Linking: the web shows a code; the user sends it to the business number from their phone.
  app.register(async (scope) => {
    scope.addHook('preHandler', requireUser);
    // Phase 2: shown right after sign-up (no twin needed yet) and on My twin. User-initiated, so it needs
    // no template and opens the 24-hour window for the welcome message.
    const issueCode = async (userId: string) => {
      if (limited(`verify-code:${userId}`, 10, HOUR)) throw Object.assign(new Error('rate_limited'), { statusCode: 429 });
      for (const [c, v] of linkCodes) if (v.userId === userId || v.expires < Date.now()) linkCodes.delete(c);
      const code = String(randomInt(100_000, 1_000_000));
      linkCodes.set(code, { userId, expires: Date.now() + 15 * 60_000 });
      const number = config.WA_PHONE_NUMBER?.replace(/\D/g, '') || null;
      const [u] = await deps.db.select({ phone: users.phoneE164 }).from(users).where(eq(users.id, userId));
      return {
        code, number, verified: Boolean(u?.phone), phone: u?.phone ?? null,
        wa_link: number ? `https://wa.me/${number}?text=${encodeURIComponent(`VERIFY ${code}`)}` : null,
        enabled: Boolean(deps.wa),
      };
    };
    scope.post('/me/whatsapp/code', async (req) => issueCode(req.user.sub));
    scope.get('/me/whatsapp', async (req) => {
      const [u] = await deps.db.select({ phone: users.phoneE164, verifiedAt: users.verifiedAt }).from(users).where(eq(users.id, req.user.sub));
      return { verified: Boolean(u?.phone), phone: u?.phone ?? null, verified_at: u?.verifiedAt ?? null };
    });
    scope.post<{ Params: { id: string } }>('/ipersons/:id/whatsapp/code', async (req, reply) => {
      const ip = await ownIperson(deps, req, req.params.id);
      if (!ip) return reply.code(404).send({ error: 'not_found' });
      return issueCode(req.user.sub);
    });
    scope.delete<{ Params: { id: string } }>('/ipersons/:id/whatsapp', async (req, reply) => {
      const ip = await ownIperson(deps, req, req.params.id);
      if (!ip) return reply.code(404).send({ error: 'not_found' });
      await deps.db.update(users).set({ phoneE164: null }).where(eq(users.id, req.user.sub));
      await refreshIdentifiers(deps.db, req.user.sub);
      return { ok: true };
    });
  });
}

async function handleMessage(deps: AppDeps, msg: WaMessage, log: FastifyBaseLogger, profileName?: string) {
  const wa = deps.wa;
  if (!wa) return;
  const phone = `+${msg.from.replace(/\D/g, '')}`;
  const text = msg.text?.body?.trim() ?? '';

  const code = /^(?:(?:verify|link)\s+)?(\d{6})$/i.exec(text)?.[1];
  if (code) {
    // At most 5 wrong codes per number per 15 minutes.
    const tries = failedTries.get(phone);
    if (tries && tries.until > Date.now() && tries.n >= 5) return wa.sendText(msg.from, 'Too many attempts. Please wait 15 minutes and get a new code.');
    const pending = linkCodes.get(code);
    if (!pending || pending.expires < Date.now()) {
      failedTries.set(phone, { n: (tries && tries.until > Date.now() ? tries.n : 0) + 1, until: Date.now() + 15 * 60_000 });
      return wa.sendText(msg.from, 'That code is not valid any more. Get a new one at i-persons.com.');
    }
    // One verified account per number: a number already linked elsewhere can't verify a second account.
    const [other] = await deps.db.select({ id: users.id }).from(users).where(eq(users.phoneE164, phone));
    if (other && other.id !== pending.userId) {
      linkCodes.delete(code);
      return wa.sendText(msg.from, 'This number already verifies another i-persons account. Unlink it there first (My twin → WhatsApp).');
    }
    // Part C: the number's own region (not just its calling code) must be an allowed country.
    const region = phoneRegion(phone);
    if (!countryAllowed(await countrySettings(deps.db), region)) {
      return wa.sendText(msg.from, 'Sorry, i-persons isn’t available for phone numbers from your country yet. We’ll be there soon!');
    }
    linkCodes.delete(code);
    failedTries.delete(phone);
    await deps.db.update(users).set({ phoneE164: phone, phoneCountry: region, verifiedAt: new Date() }).where(eq(users.id, pending.userId));
    // Twin-to-twin: the number becomes matchable, and a pending invite reward/connection prompt is due.
    await onPhoneVerified(deps, pending.userId).catch((err) => log.warn({ err }, 'post-verification hooks failed'));
    // The welcome with the avatar image (now, or as soon as onboarding creates the avatar).
    if (!(await sendWelcome(deps, pending.userId))) {
      await wa.sendText(msg.from, 'Verified! Finish creating your i-person at i-persons.com and I’ll say hi here.');
    }
    return;
  }

  // Impact §3: unknown numbers can try a guest twin, after consent (no model call before it).
  const guestButton = msg.interactive?.button_reply?.id ?? msg.button?.payload;
  if (guestButton === 'guest:no') return wa.sendText(msg.from, 'No problem. Write to me any time if you change your mind.');
  if (guestButton === 'guest:agree') {
    const created = await createGuest(deps, phone, profileName, log);
    if (!created) return wa.sendText(msg.from, 'Sorry, i-persons isn’t available for numbers from your country yet.');
    if (created.pendingApprovalAt) return wa.sendText(msg.from, PENDING_GUEST);
    await wa.sendText(msg.from, `Welcome${created.name !== 'Friend' ? `, ${created.name.split(/\s+/)[0]}` : ''}! Your twin is ready. Ask me anything: plans, ideas, deals near you. You have $${((await runtimeSettings(deps.db)).guestCreditUsd).toFixed(2)} of AI credit to try it.`);
    const first = takeWaitingMessage(phone);
    if (!first) return;
    msg = { ...msg, type: 'text', text: { body: first }, interactive: undefined, button: undefined };
  }
  const [row] = await deps.db.select({ user: users, ip: ipersons }).from(users)
    .innerJoin(ipersons, eq(ipersons.userId, users.id)).where(eq(users.phoneE164, phone));
  if (!row) {
    const [known] = await deps.db.select({ id: users.id }).from(users).where(eq(users.phoneE164, phone));
    if (known) return wa.sendText(msg.from, NOT_LINKED);
    return greetUnknown(deps, msg.from, phone, msg.text?.body?.trim() ?? '');
  }
  // Beta: nothing reaches the twin until the account is approved (a reminder at most every 6 hours).
  if (row.user.pendingApprovalAt && await isPending(deps.db, row.user.id)) {
    if (!limited(`pending-reply:${phone}`, 1, 6 * 3_600_000)) await wa.sendText(msg.from, isGuest(row.user) ? PENDING_GUEST : 'Your i-persons account is waiting for approval (beta). We’ll email you as soon as it’s ready.');
    return;
  }
  if (isGuest(row.user) && guestOverLimit(phone)) {
    return wa.sendText(msg.from, `That’s today’s limit for guest twins. Finish your twin on the web to keep going: ${await magicLink(deps, row.user.id)}`);
  }
  const ipersonId = row.ip.id;

  // Approve / Decline buttons carry the single-use confirm token.
  const buttonId = msg.interactive?.button_reply?.id ?? msg.button?.payload;
  if (buttonId) {
    const [verb, token, id] = buttonId.split(':');
    if ((verb === 'keep' || verb === 'drop') && (token === 'fact' || token === 'rule') && id) {
      const done = await decideMemory(deps.db, ipersonId, token, id, verb === 'keep');
      return wa.sendText(msg.from, !done ? 'That was already handled.' : verb === 'keep' ? 'Kept. It’s on My twin.' : 'Discarded.');
    }
    if ((verb !== 'ok' && verb !== 'no' && verb !== 'bl') || !token) return;
    try {
      const result = await deps.runtime.decide({ ipersonId, token, approve: verb === 'ok' });
      if (verb === 'bl') await blockFromCard(deps, result.action); // twin connection cards: Decline + Block
      publishDecision(deps.bus, ipersonId, result);
      const fallback = verb === 'ok' ? `Done: ${result.action.summary}` : 'Okay, I won’t do it.';
      return await reply(deps, msg.from, result.followUp?.reply || fallback, result.followUp?.proposed ?? []);
    } catch (err) {
      if (err instanceof ActionError) return wa.sendText(msg.from, err.code === 'expired' ? 'That request expired. Ask me again.' : 'That was already handled.');
      throw err;
    }
  }

  let said = msg.text?.body?.trim() ?? '';
  if (msg.type === 'audio' && msg.audio) {
    if (deps.demoMode) return wa.sendText(msg.from, 'Voice notes will work once my speech model is connected. Please type for now.');
    if (deps.billing && !(await hasCredit(deps.db, row.user.id))) return wa.sendText(msg.from, NO_CREDIT_REPLY);
    const wav = await toWav16k(await wa.downloadMedia(msg.audio.id));
    const heard = await transcribeWav(wav, row.user.locale);
    if (deps.billing) await charge(deps.db, row.user.id, { kind: 'stt', model: 'muse-voice-transcribe-1.0', seconds: heard.seconds });
    said = heard.text.trim();
    if (!said) return wa.sendText(msg.from, "Sorry, I couldn't hear that. Could you try again?");
  }
  if (!said) return;

  const conversationId = await deps.runtime.conversationFor(ipersonId, 'whatsapp');
  const res = await deps.runtime.handleUserMessage({ ipersonId, conversationId, text: said });
  // Guests: the twin's "finish on the web" answer carries a fresh single-use sign-in link.
  if (res.reply.includes(WEB_LINK)) res.reply = res.reply.replaceAll(WEB_LINK, await magicLink(deps, row.user.id));
  if (res.decided) deps.bus.publish(ipersonId, { type: 'action.updated', action_id: res.decided.id, status: res.decided.status });
  log.info({ ipersonId, proposed: res.proposed.length }, 'whatsapp turn');
  await reply(deps, msg.from, res.reply, res.proposed);
  for (const m of res.pendingMemory ?? []) {
    await wa.sendButtons(msg.from, `I learned this after reading ${m.source}:\n“${m.text}”\n\nKeep it?`, [
      { id: `keep:${m.kind}:${m.id}`, title: 'Keep' },
      { id: `drop:${m.kind}:${m.id}`, title: 'Discard' },
    ]);
  }
  // Web sessions see proposals (and held memories) too, so the user can decide from either place.
  publishTurn(deps.bus, ipersonId, { reply: '', proposed: res.proposed, pendingMemory: res.pendingMemory });
}

async function reply(deps: AppDeps, to: string, text: string, proposed: ActionRow[]) {
  // A single proposal rides in the reply itself, so the user doesn't read the same thing twice.
  const merge = proposed.length === 1 && Boolean(text);
  if (text && !merge) await deps.wa!.sendText(to, text);
  for (const a of proposed) {
    const amount = a.amountCents != null && a.currency ? `\n${(a.amountCents / 100).toFixed(2)} ${a.currency}` : '';
    const body = merge && !text.includes(a.summary) ? `${text}\n\n${a.summary}` : merge ? text : a.summary;
    const note = (a.influencedBy ? `\n\n⚠ Suggested after reading ${a.influencedBy}.` : '') + (a.heldReason ? `\n\n⚠ ${a.heldReason}. Tap Approve only if it's right.` : '');
    await deps.wa!.sendButtons(to, `${body}${amount}${note}`, [
      { id: `ok:${a.confirmToken}`, title: 'Approve' },
      { id: `no:${a.confirmToken}`, title: 'Decline' },
    ]);
  }
}

/**
 * Phase 2.2: "Hi <name>, I'm your i-person…" with the avatar image, once, inside the 24-hour window that
 * the user's VERIFY message opened. Returns false when there's no avatar yet (it's sent on avatar choice).
 */
export async function sendWelcome(deps: AppDeps, userId: string): Promise<boolean> {
  const [row] = await deps.db.select({ user: users, ip: ipersons }).from(users).leftJoin(ipersons, eq(ipersons.userId, users.id)).where(eq(users.id, userId));
  if (!deps.wa || !row?.user.phoneE164 || row.user.welcomedAt || !row.ip?.avatarUrl) return false;
  const file = row.ip.avatarUrl.replace(/^\/api\/media\//, '');
  const image = await readFile(join(config.UPLOAD_DIR, file)).catch(() => null);
  const to = row.user.phoneE164.replace(/^\+/, '');
  const caption = `Hi ${row.user.name}, I'm your i-person. Talk to me here or at i-persons.com.`;
  try {
    if (image) await deps.wa.sendImage(to, image, file.endsWith('.png') ? 'image/png' : 'image/jpeg', caption);
    else await deps.wa.sendText(to, caption);
  } catch {
    await deps.wa.sendText(to, caption).catch(() => {});
  }
  await deps.db.update(users).set({ welcomedAt: new Date() }).where(eq(users.id, userId));
  return true;
}
