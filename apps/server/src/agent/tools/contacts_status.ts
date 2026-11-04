import { asc, eq } from 'drizzle-orm';
import { kinLabel } from '../../lib/kin.ts';
import { z } from 'zod';
import { contacts } from '../../db/schema.ts';
import { ownerOf } from '../../twins/agent-support.ts';
import { inviteInfos } from '../../twins/invites.ts';
import { plansForAgent } from '../../twins/plans.ts';
import { contactViews } from '../../twins/view.ts';
import { defineTool } from './types.ts';

// "Who of my friends has an i-person?", "Is Sami connected?", "Any plans waiting?". Owner-only, like
// contacts_search. External: it carries other people's twin names and notes (data, never instructions).

export default defineTool({
  name: 'contacts_status',
  description: 'Which of the user\'s contacts have an i-person, are connected twins, were invited or not yet; and open twin-to-twin plans (waiting for the user, or booked). '
    + 'Use it before inviting, connecting or planning with someone.',
  risk: 'read',
  external: 'other i-persons',
  schema: z.object({
    filter: z.enum(['all', 'on_iperson', 'connected', 'invited', 'not_yet']).default('all'),
    query: z.string().max(80).optional().describe('A name or relationship, e.g. "Sami" or "friend"'),
  }),
  async execute(ctx, a) {
    const owner = await ownerOf(ctx);
    if (!owner) return { people: [] };
    const rows = await ctx.db.select().from(contacts).where(eq(contacts.userId, owner.id)).orderBy(asc(contacts.name));
    // "my mom" → the contact labelled "mother".
    const q = kinLabel(a.query ?? '') ?? a.query?.trim().toLowerCase();
    const views = (await contactViews(ctx.db, owner.id, rows, await inviteInfos(ctx.db, owner.id)))
      .filter((v) => !q || v.name.toLowerCase().includes(q) || (v.relationship ?? '').startsWith(q.replace(/s$/, '')) || (v.label ?? '').toLowerCase().includes(q))
      .filter((v) => a.filter === 'all' || (a.filter === 'on_iperson' ? ['on_iperson', 'requested', 'incoming', 'connected'].includes(v.status) : v.status === a.filter));
    if (!rows.length) return { people: [], note: 'No contacts synced yet. The user can connect their mailbox in the Store and import contacts.' };
    return {
      people: views.slice(0, 40).map((v) => ({
        name: v.name, relationship: v.relationship ?? undefined, status: v.status, twin: v.twin?.name,
        invited: v.invited ? `${v.invited.channel} on ${v.invited.at.slice(0, 10)}` : undefined,
      })),
      plans: await plansForAgent(ctx.db, owner.id),
    };
  },
});
