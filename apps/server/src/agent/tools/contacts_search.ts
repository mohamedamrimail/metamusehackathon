import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ipersons } from '../../db/schema.ts';
import { searchContacts } from '../../mail/people.ts';
import { defineTool } from './types.ts';

// The owner's own people (address book + opt-in mailbox scan). Owner-only: visitor and partner twins
// have their own tool sets and never get this one.

export default defineTool({
  name: 'contacts_search',
  description: 'Find people the user knows (family, friends, colleagues, clients) from their address book and emails. '
    + 'Leave query empty to list everyone, or filter by relationship. Use it for any question about people in the user\'s life.',
  risk: 'read',
  // Notes come from emails and the address book: outside data for the model.
  external: 'your emails and contacts',
  schema: z.object({
    query: z.string().max(80).optional().describe('A name, role ("brother", "accountant"), company or topic'),
    relationship: z.enum(['family', 'friend', 'colleague', 'client', 'business', 'other']).optional(),
  }),
  async execute(ctx, a) {
    const [ip] = await ctx.db.select({ userId: ipersons.userId }).from(ipersons).where(eq(ipersons.id, ctx.ipersonId));
    if (!ip) return { people: [] };
    const rows = await searchContacts(ctx.db, ip.userId, a.query?.trim() || undefined, a.relationship);
    if (!rows.length) {
      return { people: [], note: 'Nobody found. If the user wants, they can connect their mailbox in the Store and turn on "Learn who I know" so you can learn from their emails, address book and calendar.' };
    }
    return {
      people: rows.map((r) => ({
        name: r.name, relationship: r.relationship ?? undefined, role: r.label ?? undefined, about: r.notes ?? undefined,
        email: (r.emails as string[])[0], birthday: r.birthday ?? undefined,
        emails_exchanged: r.mailsTo + r.mailsFrom || undefined, last_contact: r.lastContactAt?.toISOString().slice(0, 10),
      })),
    };
  },
});
