import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mailTransport } from '../lib/mailer.ts';
import { z } from 'zod';
import { microsToUsd, usdToMicros } from '../billing/credits.ts';
import { config } from '../config.ts';
import { adminLog, aiUsage, familyGroups, familyInvites, familyMembers, gifts, plusInterest, users } from '../db/schema.ts';
import { approveUser } from '../lib/approval.ts';
import { HOUR, limited } from '../lib/ratelimit.ts';
import { runtimeSettings } from '../lib/settings.ts';
import { normaliseEmail, normalisePhone } from '../twins/identifiers.ts';
import { requireUser } from './auth.ts';
import type { AppDeps } from './deps.ts';

// Impact §4: /pricing (Free, Plus "coming soon", Family, Gift), the gift flow and family plans.
// No payment provider yet: gift requests wait as pending_payment and the team marks them paid in admin;
// family pools are funded by an admin top-up. Family privacy: the payer only ever sees each member's
// first name, total spend since joining and remaining credit, never anything from their twin.

export const FAMILY_MAX_MEMBERS = 5;
const INVITE_DAYS = 14;
const admins = () => config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const transport = () => (config.SMTP_URL ? mailTransport(config.SMTP_URL) : undefined);
const firstName = (n: string) => n.split(/\s+/)[0] ?? n;
const usd = (micros: number) => Math.round(microsToUsd(micros) * 100) / 100;
const giftCode = () => `GIFT-${randomBytes(4).toString('hex').toUpperCase()}`;
export const redeemLink = (code: string) => `${config.PUBLIC_URL}/redeem?code=${code}`;
export const familyJoinLink = (token: string) => `${config.PUBLIC_URL}/family/join/${token}`;

/** The signed-in user id, if any (pages that work signed in or out). */
async function optionalUser(req: FastifyRequest): Promise<string | undefined> {
  try {
    await req.jwtVerify({ onlyCookie: true });
    const c = req.user as { sub?: string; typ?: string };
    return c.sub && !c.typ ? c.sub : undefined;
  } catch { return undefined; }
}

/** The text a gift recipient gets (email, or WhatsApp forwarded by the buyer). */
export function giftText(g: { recipientName: string; buyerName: string; amountMicros: number; message: string | null }, code: string) {
  return `Hi ${firstName(g.recipientName)}! ${firstName(g.buyerName)} gave you $${usd(g.amountMicros)} of AI credit for your own i-person, a digital twin that acts for you, never without your yes.`
    + `${g.message ? `\n\n"${g.message}"` : ''}\n\nYour gift code: ${code}\nStart here: ${redeemLink(code)}`;
}

/** Marks a gift paid, makes its code and sends it (email; a wa.me link for the buyer to forward otherwise). */
export async function markGiftPaid(deps: Pick<AppDeps, 'db'>, id: string) {
  const code = giftCode();
  const [g] = await deps.db.update(gifts).set({ status: 'paid', paidAt: new Date(), code })
    .where(and(eq(gifts.id, id), eq(gifts.status, 'pending_payment'))).returning();
  if (!g) return undefined;
  const text = giftText(g, code);
  const waLink = g.recipientPhone ? `https://wa.me/${g.recipientPhone.replace(/^\+/, '')}?text=${encodeURIComponent(text)}` : null;
  const t = transport();
  let emailed = false;
  if (t && g.recipientEmail) {
    await t.sendMail({ from: config.SMTP_FROM, to: g.recipientEmail, subject: `${firstName(g.buyerName)} gave you an i-person`, text })
      .then(() => { emailed = true; }, () => {});
  }
  // The buyer gets a receipt, plus the WhatsApp link when the gift goes out from their own phone (as with invites).
  const buyerEmail = normaliseEmail(g.buyerContact);
  if (t && buyerEmail) {
    await t.sendMail({
      from: config.SMTP_FROM, to: buyerEmail, subject: 'Your i-persons gift is ready',
      text: `Thank you! Your gift of $${usd(g.amountMicros)} for ${g.recipientName} is paid.\n\nGift code: ${code}\n`
        + (emailed ? `We emailed it to ${g.recipientEmail}.\n` : '')
        + (waLink ? `Send it from your own WhatsApp: ${waLink}\n` : '')
        + `\n— the i-persons team`,
    }).catch(() => {});
  }
  return { gift: g, code, emailed, wa_link: waLink, redeem_link: redeemLink(code) };
}

export async function pricingRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const tooMany = (reply: FastifyReply) => reply.code(429).send({ error: 'rate_limited', message: 'Too many requests. Please wait a little.' });

  app.get('/pricing/info', async () => {
    const s = await runtimeSettings(db);
    return { free_usd: s.freeCreditUsd, plus_price_usd: s.plusPriceUsd, gift_presets_usd: s.giftPresetsUsd, family_max_members: FAMILY_MAX_MEMBERS, payment_available: Boolean(config.PAYMENT_PROVIDER) };
  });

  // "Plus — coming soon": record the interest (signed in, or with an email).
  app.post('/pricing/plus-interest', async (req, reply) => {
    if (limited(`plus:${req.ip}`, 10, HOUR)) return tooMany(reply);
    const userId = await optionalUser(req);
    const [u] = userId ? await db.select({ email: users.email }).from(users).where(eq(users.id, userId)) : [];
    const email = u?.email ?? normaliseEmail(String((req.body as { email?: unknown } | undefined)?.email ?? ''));
    if (!email) return reply.code(400).send({ error: 'invalid', message: 'Enter your email.' });
    await db.insert(plusInterest).values({ userId: u ? userId : null, email }).onConflictDoNothing();
    return { ok: true };
  });

  // --- gifts ---
  app.post('/gifts', async (req, reply) => {
    if (limited(`gift:${req.ip}`, 5, HOUR)) return tooMany(reply);
    const presets = (await runtimeSettings(db)).giftPresetsUsd;
    const body = z.object({
      buyer_name: z.string().trim().min(1).max(80),
      buyer_contact: z.string().trim().min(5).max(120),
      recipient_name: z.string().trim().min(1).max(60),
      recipient_email: z.string().trim().max(120).optional(),
      recipient_phone: z.string().trim().max(30).optional(),
      amount_usd: z.number().refine((n) => presets.includes(n), 'Pick one of the amounts.'),
      message: z.string().trim().max(300).optional(),
      country: z.string().regex(/^[A-Z]{2}$/).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: body.error.issues[0]?.message ?? 'Check the form.' });
    const d = body.data;
    const recipientEmail = d.recipient_email ? normaliseEmail(d.recipient_email) : null;
    const recipientPhone = d.recipient_phone ? normalisePhone(d.recipient_phone, d.country) : null;
    if (!recipientEmail && !recipientPhone) return reply.code(400).send({ error: 'invalid', message: 'Add the recipient’s email or WhatsApp number (with country code).' });
    const buyerContact = normaliseEmail(d.buyer_contact) ?? normalisePhone(d.buyer_contact, d.country);
    if (!buyerContact) return reply.code(400).send({ error: 'invalid', message: 'Add your email or WhatsApp number so we can complete the payment.' });
    const [g] = await db.insert(gifts).values({
      buyerUserId: (await optionalUser(req)) ?? null, buyerName: d.buyer_name, buyerContact, recipientName: d.recipient_name,
      recipientEmail, recipientPhone, amountMicros: usdToMicros(d.amount_usd), message: d.message || null,
    }).returning();
    // HACKATHON: no payment provider; the team contacts the buyer, then marks the gift paid in admin.
    await transport()?.sendMail({
      from: config.SMTP_FROM, to: config.APPROVAL_EMAIL, subject: `Gift request: $${d.amount_usd} from ${d.buyer_name}`,
      text: `${d.buyer_name} (${buyerContact}) wants to gift $${d.amount_usd} to ${d.recipient_name} (${recipientEmail ?? recipientPhone}).\n\nComplete the payment with them, then mark it paid: ${config.PUBLIC_URL}/admin (Gifts)`,
    }).catch(() => {});
    return { id: g!.id, status: g!.status, message: 'Thank you! We’ll contact you to complete the payment, then send your gift.' };
  });

  // Redeeming works while an account still waits for beta approval: a paid gift is the team's yes.
  app.post('/gifts/redeem', { preHandler: requireUser }, async (req, reply) => {
    const code = z.object({ code: z.string().trim().toUpperCase().max(30) }).safeParse(req.body);
    if (!code.success) return reply.code(400).send({ error: 'invalid' });
    const [g] = await db.update(gifts).set({ status: 'redeemed', redeemedAt: new Date(), redeemedBy: req.user.sub })
      .where(and(eq(gifts.code, code.data.code), eq(gifts.status, 'paid'))).returning();
    if (!g) return reply.code(404).send({ error: 'invalid_code', message: 'This gift code isn’t valid or was already used.' });
    await db.update(users).set({ aiCreditMicros: sql`${users.aiCreditMicros} + ${g.amountMicros}`, giftAt: sql`coalesce(${users.giftAt}, now())` }).where(eq(users.id, req.user.sub));
    await approveUser(deps, req.user.sub);
    return { ok: true, amount_usd: usd(g.amountMicros), from: firstName(g.buyerName) };
  });

  // --- family plans ---
  const familyOf = async (userId: string) => {
    const [owned] = await db.select().from(familyGroups).where(eq(familyGroups.ownerId, userId));
    if (owned) return { role: 'owner' as const, group: owned };
    const [m] = await db.select({ group: familyGroups }).from(familyMembers).innerJoin(familyGroups, eq(familyGroups.id, familyMembers.groupId)).where(eq(familyMembers.userId, userId));
    return m ? { role: 'member' as const, group: m.group } : undefined;
  };

  app.get('/me/family', { preHandler: requireUser }, async (req) => {
    const f = await familyOf(req.user.sub);
    if (!f) return { family: null };
    const { group } = f;
    if (f.role === 'member') {
      const [owner] = await db.select({ name: users.name }).from(users).where(eq(users.id, group.ownerId));
      return { family: { role: 'member', name: group.name, owner: firstName(owner?.name ?? ''), pool_usd: usd(group.poolMicros) } };
    }
    // Privacy: first name, spend since joining and remaining credit. Nothing else about members leaves here.
    const members = await db.select({
      id: users.id, name: users.name, credit: users.aiCreditMicros, joinedAt: familyMembers.joinedAt,
      spent: sql<string>`coalesce((select sum(${aiUsage.metaCostMicros} + ${aiUsage.feeMicros}) from ${aiUsage} where ${aiUsage.userId} = ${users.id} and ${aiUsage.createdAt} >= ${familyMembers.joinedAt}), 0)`,
    }).from(familyMembers).innerJoin(users, eq(users.id, familyMembers.userId)).where(eq(familyMembers.groupId, group.id)).orderBy(familyMembers.joinedAt);
    const invites = await db.select().from(familyInvites)
      .where(and(eq(familyInvites.groupId, group.id), isNull(familyInvites.acceptedAt), gt(familyInvites.expiresAt, new Date()))).orderBy(desc(familyInvites.createdAt));
    return {
      family: {
        role: 'owner', id: group.id, name: group.name, pool_usd: usd(group.poolMicros), max_members: FAMILY_MAX_MEMBERS,
        members: members.map((m) => ({ id: m.id, name: firstName(m.name), spent_usd: usd(Number(m.spent)), credit_usd: usd(m.credit), joined_at: m.joinedAt })),
        invites: invites.map((i) => ({ token: i.token, label: i.label, link: familyJoinLink(i.token), expires_at: i.expiresAt })),
      },
    };
  });

  // "Request Family plan": creates the group; the team funds the pool (admin top-up) once paid.
  app.post('/me/family', { preHandler: requireUser }, async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'Give your family a name.' });
    if (await familyOf(req.user.sub)) return reply.code(409).send({ error: 'already_in_family', message: 'You’re already in a family plan.' });
    const [g] = await db.insert(familyGroups).values({ ownerId: req.user.sub, name: body.data.name }).returning();
    const [owner] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, req.user.sub));
    await transport()?.sendMail({
      from: config.SMTP_FROM, to: config.APPROVAL_EMAIL, subject: `Family plan request: ${body.data.name}`,
      text: `${owner?.name} <${owner?.email}> requested a family plan ("${body.data.name}"). Arrange the payment, then top up the pool: ${config.PUBLIC_URL}/admin (Families)`,
    }).catch(() => {});
    return reply.code(201).send({ id: g!.id });
  });

  app.post('/me/family/invites', { preHandler: requireUser }, async (req, reply) => {
    const f = await familyOf(req.user.sub);
    if (f?.role !== 'owner') return reply.code(403).send({ error: 'not_owner' });
    const label = z.object({ label: z.string().trim().max(60).optional() }).safeParse(req.body ?? {});
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(familyMembers).where(eq(familyMembers.groupId, f.group.id)) as [{ n: number }];
    if (n >= FAMILY_MAX_MEMBERS) return reply.code(409).send({ error: 'family_full', message: `A family plan has up to ${FAMILY_MAX_MEMBERS} members.` });
    const token = randomBytes(18).toString('base64url');
    await db.insert(familyInvites).values({ token, groupId: f.group.id, label: label.success ? label.data.label || null : null, expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) });
    const [owner] = await db.select({ name: users.name }).from(users).where(eq(users.id, req.user.sub));
    const text = `${firstName(owner?.name ?? '')} invites you to the "${f.group.name}" family plan on i-persons: your own digital twin, with AI credit paid by ${firstName(owner?.name ?? '')}. Join here: ${familyJoinLink(token)}`;
    return { token, link: familyJoinLink(token), text, wa_link: `https://wa.me/?text=${encodeURIComponent(text)}` };
  });

  app.get<{ Params: { token: string } }>('/family-invites/:token', async (req, reply) => {
    const [row] = await db.select({ inv: familyInvites, group: familyGroups, owner: users.name }).from(familyInvites)
      .innerJoin(familyGroups, eq(familyGroups.id, familyInvites.groupId)).innerJoin(users, eq(users.id, familyGroups.ownerId))
      .where(eq(familyInvites.token, req.params.token));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { family: row.group.name, owner: firstName(row.owner), valid: !row.inv.acceptedAt && row.inv.expiresAt > new Date() };
  });

  // Works while the account waits for beta approval (joining is recorded; using the twin still needs approval).
  app.post<{ Params: { token: string } }>('/family-invites/:token/accept', { preHandler: requireUser }, async (req, reply) => {
    const refuse = (message: string) => reply.code(409).send({ error: 'cannot_join', message });
    if (await familyOf(req.user.sub)) return refuse('You’re already in a family plan. Leave it first.');
    const result = await db.transaction(async (tx) => {
      const [inv] = await tx.select().from(familyInvites).where(eq(familyInvites.token, req.params.token)).for('update');
      if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) return 'This invite isn’t valid any more. Ask for a new one.';
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(familyMembers).where(eq(familyMembers.groupId, inv.groupId)) as [{ n: number }];
      if (n >= FAMILY_MAX_MEMBERS) return 'This family plan is full.';
      await tx.update(familyInvites).set({ acceptedAt: new Date(), acceptedBy: req.user.sub }).where(eq(familyInvites.token, inv.token));
      await tx.insert(familyMembers).values({ groupId: inv.groupId, userId: req.user.sub });
      return null;
    });
    return result ? refuse(result) : { ok: true };
  });

  // Members can leave at any time; the pool stays with the owner.
  app.post('/me/family/leave', { preHandler: requireUser }, async (req, reply) => {
    const [gone] = await db.delete(familyMembers).where(eq(familyMembers.userId, req.user.sub)).returning();
    if (!gone) return reply.code(404).send({ error: 'not_member' });
    return { ok: true };
  });

  // --- admin: gifts and family pools ---
  const adminEmail = new WeakMap<FastifyRequest, string>();
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/admin/') && !req.url.startsWith('/api/admin/')) return;
    await requireUser(req, reply);
    if (reply.sent) return;
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.user.sub));
    if (!u || !admins().includes(u.email)) return reply.code(403).send({ error: 'not_admin' });
    adminEmail.set(req, u.email);
  });
  const log = (req: FastifyRequest, action: string, detail: unknown) => db.insert(adminLog).values({ admin: adminEmail.get(req)!, action, detail });

  app.get('/admin/gifts', async () => ({
    gifts: (await db.select().from(gifts).orderBy(desc(gifts.createdAt)).limit(100)).map((g) => ({
      id: g.id, status: g.status, amount_usd: usd(g.amountMicros), buyer_name: g.buyerName, buyer_contact: g.buyerContact,
      recipient_name: g.recipientName, recipient: g.recipientEmail ?? g.recipientPhone, code: g.code, created_at: g.createdAt,
      wa_link: g.code && g.recipientPhone ? `https://wa.me/${g.recipientPhone.replace(/^\+/, '')}?text=${encodeURIComponent(giftText(g, g.code))}` : null,
    })),
  }));
  app.post<{ Params: { id: string } }>('/admin/gifts/:id/paid', async (req, reply) => {
    if (!z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid' });
    const r = await markGiftPaid(deps, req.params.id);
    if (!r) return reply.code(404).send({ error: 'not_found', message: 'No gift waiting for payment with this id.' });
    await log(req, 'gift.paid', { gift: r.gift.id, amount_usd: usd(r.gift.amountMicros) });
    return { code: r.code, emailed: r.emailed, wa_link: r.wa_link, redeem_link: r.redeem_link };
  });
  app.post<{ Params: { id: string } }>('/admin/gifts/:id/cancel', async (req, reply) => {
    if (!z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid' });
    const [g] = await db.update(gifts).set({ status: 'cancelled' }).where(and(eq(gifts.id, req.params.id), eq(gifts.status, 'pending_payment'))).returning();
    if (!g) return reply.code(404).send({ error: 'not_found' });
    await log(req, 'gift.cancel', { gift: g.id });
    return { ok: true };
  });

  app.get('/admin/families', async () => {
    const rows = await db.select({ g: familyGroups, owner: users.email, members: sql<number>`(select count(*)::int from ${familyMembers} where ${familyMembers.groupId} = ${familyGroups.id})` })
      .from(familyGroups).innerJoin(users, eq(users.id, familyGroups.ownerId)).orderBy(desc(familyGroups.createdAt));
    return { families: rows.map((r) => ({ id: r.g.id, name: r.g.name, owner: r.owner, members: r.members, pool_usd: usd(r.g.poolMicros), created_at: r.g.createdAt })) };
  });
  app.post<{ Params: { id: string } }>('/admin/families/:id/topup', async (req, reply) => {
    const body = z.object({ amount_usd: z.number().min(-500).max(500).refine((n) => n !== 0), reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
    if (!body.success || !z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'invalid', message: 'An amount and a reason are required.' });
    const [g] = await db.update(familyGroups).set({ poolMicros: sql`${familyGroups.poolMicros} + ${usdToMicros(body.data.amount_usd)}` }).where(eq(familyGroups.id, req.params.id)).returning();
    if (!g) return reply.code(404).send({ error: 'not_found' });
    await log(req, 'family.topup', { family: g.name, amount_usd: body.data.amount_usd, reason: body.data.reason });
    return { pool_usd: usd(g.poolMicros) };
  });
}
