import { z } from 'zod';
import { ipersonRules } from '../../db/schema.ts';
import { defineTool } from './types.ts';

export default defineTool({
  name: 'add_rule',
  description: 'Add a lasting rule for how you (the twin) behave: something to always do or never do. Use when the user states one ("never book on Sundays"), or when their repeated choices clearly show one (source learned). It is listed on My twin, where the user can edit or remove it.',
  risk: 'read',
  schema: z.object({
    kind: z.enum(['do', 'dont']),
    text: z.string().min(3).max(200).describe('Short imperative, e.g. "Never book anything on Sundays"'),
    source: z.enum(['chat', 'learned']).default('chat').describe('chat: the user said it; learned: you inferred it from their behaviour'),
    why: z.string().max(200).optional().describe('What it came from, e.g. the user’s words or the pattern you noticed'),
  }),
  async execute(ctx, a) {
    // Like facts: a rule proposed right after reading outside content waits for the user's keep.
    const outside = ctx.influence?.() ?? [];
    const source = outside.join(', ');
    const [row] = await ctx.db.insert(ipersonRules).values({
      ipersonId: ctx.ipersonId, kind: a.kind, text: a.text, source: a.source, sourceNote: a.why,
      ...(outside.length ? { status: 'pending', sourceHint: source } : {}),
    }).returning({ id: ipersonRules.id });
    if (outside.length) {
      ctx.onPendingMemory?.({ kind: 'rule', id: row!.id, text: `${a.kind === 'do' ? 'Always' : 'Never'}: ${a.text}`, source });
      return { saved: false, pending: true, note: `Not saved yet: it came right after reading ${source}. The user sees a Keep / Discard prompt.` };
    }
    return { saved: true, rule_id: row!.id, note: 'Tell the user it is on their rules list on My twin.' };
  },
});
