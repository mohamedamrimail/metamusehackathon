import type { ActionRow } from '../agent/runtime.ts';
import type { TwinRequestArgs } from '../agent/tools/twin_request.ts';
import type { ToolContext } from '../agent/tools/types.ts';
import { ipersons, planParticipants } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import type { AppDeps } from '../http/deps.ts';
import { ownConnection, respond } from './connections.ts';
import { acceptSuggestion } from './suggestions.ts';
import { pairConnection } from './matching.ts';
import { answerPlan, bookPlan, cancelPlan, loadPlan, maybeCompose, planView, proceedWithout, sendOptions, shareTimes } from './plans.ts';

// Runs approved twin-to-twin cards (internal tool `twin_request`) and settles declined/expired ones.
// Every handler re-checks that the person who approved is the one the card was for.

type Fulfil = (deps: AppDeps, userId: string, args: TwinRequestArgs) => Promise<unknown>;
type Settle = (deps: AppDeps, userId: string, args: TwinRequestArgs, status: 'rejected' | 'expired', action: ActionRow) => Promise<void>;

/** Planning (§5) registers its kinds here. */
export const twinKinds: Partial<Record<TwinRequestArgs['kind'], { fulfil: Fulfil; settle?: Settle }>> = {
  connect: {
    async fulfil(deps, userId, a) {
      const conn = a.connection_id ? await ownConnection(deps.db, userId, a.connection_id) : undefined;
      if (!conn || conn.recipientId !== userId) return { error: 'this request is no longer open' };
      const row = await respond(deps, userId, conn.id, 'accept', { viaCard: true });
      return { connected: row.status === 'active' };
    },
    async settle(deps, userId, a, status) {
      // An unanswered card just closes; the request stays on the Contacts page until answered there.
      if (status !== 'rejected' || !a.connection_id) return;
      const conn = await ownConnection(deps.db, userId, a.connection_id);
      if (conn?.status === 'pending' && conn.recipientId === userId) await respond(deps, userId, conn.id, 'decline', { viaCard: true });
    },
  },
};

// --- planning cards (§5) ---
const sid = (a: TwinRequestArgs) => a.session_id ?? '';
const participantOf = async (deps: AppDeps, a: TwinRequestArgs) =>
  a.participant_id ? (await deps.db.select().from(planParticipants).where(eq(planParticipants.id, a.participant_id)))[0] : undefined;

twinKinds.share_times = {
  fulfil: (deps, userId, a) => shareTimes(deps, userId, a.participant_id ?? ''),
  async settle(deps, userId, a, status) {
    const p = await participantOf(deps, a);
    if (!p || p.userId !== userId || p.status !== 'asked') return;
    await deps.db.update(planParticipants).set({ status: status === 'rejected' ? 'declined' : 'expired', respondedAt: new Date() }).where(eq(planParticipants.id, p.id));
    await maybeCompose(deps, p.sessionId);
  },
};
twinKinds.send_options = {
  fulfil: (deps, userId, a) => sendOptions(deps, userId, sid(a)),
  settle: async (deps, userId, a, status) => { if (status === 'rejected') await cancelPlan(deps, userId, sid(a)); },
};
twinKinds.choose = {
  // Approve on the card = the first remaining time and place; other choices are made on the Contacts page.
  async fulfil(deps, userId, a) {
    const v = await planView(deps.db, userId, sid(a));
    const slot = v?.slots.find((x) => !x.removed);
    if (!v?.can_answer || !slot) return { error: 'this plan is no longer waiting for your answer' };
    await answerPlan(deps, userId, v.id, { slot_option_ids: [slot.id], place_option_id: v.places.find((x) => !x.removed)?.id }, { viaCard: true });
    return { accepted: slot.label };
  },
  async settle(deps, userId, a, status) {
    const v = await planView(deps.db, userId, sid(a));
    if (!v?.can_answer) return;
    if (status === 'rejected') await answerPlan(deps, userId, v.id, { decline: true }, { viaCard: true }).catch(() => {});
  },
};
twinKinds.proceed_without = {
  fulfil: (deps, userId, a) => proceedWithout(deps, userId, sid(a)),
  settle: async (deps, userId, a, status) => { if (status === 'rejected') await cancelPlan(deps, userId, sid(a)); },
};
twinKinds.confirm = {
  async fulfil(deps, userId, a) {
    const v = await planView(deps.db, userId, sid(a));
    if (v?.role !== 'creator') return { error: 'not your plan' };
    return bookPlan(deps, sid(a));
  },
  settle: async (deps, userId, a, status) => { if (status === 'rejected') await cancelPlan(deps, userId, sid(a)); },
};

twinKinds.suggest = {
  fulfil: (deps, userId, a) => acceptSuggestion(deps, userId, a.connection_id ?? ''),
};

const ownerOf = async (deps: AppDeps, ipersonId: string) =>
  (await deps.db.select({ userId: ipersons.userId }).from(ipersons).where(eq(ipersons.id, ipersonId)))[0]?.userId;

export async function fulfilTwinRequest(deps: AppDeps, ctx: ToolContext, a: TwinRequestArgs): Promise<unknown> {
  const userId = await ownerOf(deps, ctx.ipersonId);
  const kind = twinKinds[a.kind];
  if (!userId || !kind) return { error: 'not available' };
  return kind.fulfil(deps, userId, a);
}

/** Wired as part of the runtime's onSettled: declined or expired twin cards. */
export async function settleTwinRequest(deps: AppDeps, action: ActionRow): Promise<void> {
  if (action.tool !== 'twin_request' || (action.status !== 'rejected' && action.status !== 'expired')) return;
  const userId = await ownerOf(deps, action.ipersonId);
  const a = action.args as TwinRequestArgs;
  const kind = twinKinds[a.kind];
  if (userId && kind?.settle) await kind.settle(deps, userId, a, action.status, action);
}

/** WhatsApp "Block" button on a connection or plan request card: decline, then block the other person. */
export async function blockFromCard(deps: AppDeps, action: ActionRow): Promise<void> {
  const a = action.args as TwinRequestArgs;
  const userId = await ownerOf(deps, action.ipersonId);
  if (action.tool !== 'twin_request' || !userId) return;
  const plan = a.session_id ? await loadPlan(deps.db, a.session_id) : undefined;
  const conn = a.connection_id ? await ownConnection(deps.db, userId, a.connection_id)
    : plan && plan.session.creatorId !== userId ? await pairConnection(deps.db, userId, plan.session.creatorId) : undefined;
  if (conn && conn.status !== 'blocked') await respond(deps, userId, conn.id, 'block');
}
