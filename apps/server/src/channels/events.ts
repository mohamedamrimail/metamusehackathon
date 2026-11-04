import type { ActionProposed, ServerEvent } from '@ipersons/shared';
import type { ActionRow, DecisionResult, TurnResult } from '../agent/runtime.ts';
import type { EventBus } from '../lib/bus.ts';

export function proposedEvent(a: ActionRow): ActionProposed {
  return {
    type: 'action.proposed',
    action_id: a.id,
    tool: a.tool,
    summary: a.summary,
    risk: a.risk,
    ...(a.amountCents != null && a.currency ? { amount: { cents: a.amountCents, currency: a.currency } } : {}),
    expires_at: a.expiresAt.toISOString(),
    ...(a.influencedBy ? { influenced_by: a.influencedBy } : {}),
    ...(a.heldReason ? { held: a.heldReason } : {}),
  };
}

export const updatedEvent = (a: ActionRow): ServerEvent =>
  ({ type: 'action.updated', action_id: a.id, status: a.status, result: a.result ?? undefined });

/** Sends a turn's outcome to every open session of the i-person. */
export function publishTurn(bus: EventBus, ipersonId: string, res: TurnResult): void {
  if (res.decided) bus.publish(ipersonId, updatedEvent(res.decided));
  if (res.reply) bus.publish(ipersonId, { type: 'agent.text', text: res.reply, final: true, mood: res.mood });
  for (const a of res.proposed) bus.publish(ipersonId, proposedEvent(a));
  if (res.pendingMemory?.length) bus.publish(ipersonId, { type: 'memory.pending', items: res.pendingMemory });
}

export function publishDecision(bus: EventBus, ipersonId: string, d: DecisionResult): void {
  bus.publish(ipersonId, updatedEvent(d.action));
  if (d.followUp) publishTurn(bus, ipersonId, d.followUp);
}
