import { z } from 'zod';
import { findContact, ownerOf, twinDeps } from '../../twins/agent-support.ts';
import { connectRefusal, requestConnection } from '../../twins/connections.ts';
import { defineTool } from './types.ts';

// "Connect my twin with Sami's." Needs the user's yes; then Sami gets an approval card of his own.

export default defineTool({
  name: 'connect_twins',
  description: 'Ask a contact who has an i-person to connect twins with the user (so the twins can plan together). The other person must accept. Needs approval.',
  risk: 'write',
  schema: z.object({ contact: z.string().min(1).max(80) }),
  summarize: (a) => `Ask ${a.contact}'s i-person to connect with yours`,
  async check(ctx, a) {
    const owner = await ownerOf(ctx);
    const c = owner ? await findContact(ctx.db, owner.id, a.contact) : undefined;
    if (!owner || !c) return `No contact called ${a.contact}.`;
    if (!c.hasIperson || !c.matchedUserId) return `${c.name} isn't on i-persons yet; you could invite them.`;
    return connectRefusal(ctx.db, owner.id, c.matchedUserId, ctx.now);
  },
  async execute(ctx, a) {
    const owner = await ownerOf(ctx);
    const c = owner ? await findContact(ctx.db, owner.id, a.contact) : undefined;
    if (!owner || !c?.matchedUserId || !twinDeps.deps) throw new Error('contact not found');
    await requestConnection(twinDeps.deps, owner.id, c.matchedUserId, { contactName: c.name, now: ctx.now });
    return { requested: c.name, status: 'waiting for their yes' };
  },
});
