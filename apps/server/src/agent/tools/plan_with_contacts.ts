import { eq } from 'drizzle-orm';
import { ipersons } from '../../db/schema.ts';
import { PlanInput, planRefusal, planSummary } from '../../twins/plans.ts';
import { defineTool, type ToolContext } from './types.ts';

// Twin-to-twin planning (§5a): "Plan a coffee with Sami next week". Only proposes: the card reads
// "Ask Sami's i-person for coffee next week, 1 hour, central Sfax?" and Approve sends the request.
// The negotiation itself is a structured protocol in src/twins/plans.ts, never model-to-model chat.

export const planHandler: { start?: (ctx: ToolContext, userId: string, args: PlanInput) => Promise<unknown> } = {};

const ownerOf = async (ctx: ToolContext) =>
  (await ctx.db.select({ userId: ipersons.userId }).from(ipersons).where(eq(ipersons.id, ctx.ipersonId)))[0]?.userId;

export default defineTool({
  name: 'plan_with_contacts',
  description: 'Plan a meeting, coffee, dinner, lunch, sport, walk or custom activity with 1–3 connected contacts: their i-persons find times that suit everyone and you propose places. '
    + 'Needs the user\'s approval to send. Ask one short question if the type or the dates are missing; default to 60 minutes and "any" time of day.',
  risk: 'write',
  schema: PlanInput,
  summarize: (a) => planSummary(a, a.contacts),
  async check(ctx, a) {
    const userId = await ownerOf(ctx);
    return userId ? planRefusal(ctx.db, userId, a, ctx.now) : 'unknown user';
  },
  async execute(ctx, a) {
    const userId = await ownerOf(ctx);
    if (!userId || !planHandler.start) throw new Error('planning is not available');
    return planHandler.start(ctx, userId, a);
  },
});
