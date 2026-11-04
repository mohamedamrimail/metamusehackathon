import { z } from 'zod';
import { FACT_CATEGORIES, upsertFact } from '../memory.ts';
import { defineTool } from './types.ts';

// Phase J2: right after reading outside content (web, emails, MCP…) a fact is held as pending until the
// user keeps it, so a page or email can never plant a lasting memory. What the user says directly is saved.

export default defineTool({
  name: 'remember_fact',
  description: 'Save a lasting fact about the user (preference, routine, goal, constraint or contact). Same category+key overwrites.',
  risk: 'read',
  schema: z.object({
    category: z.enum(FACT_CATEGORIES),
    key: z.string().min(1).max(80).describe('Short snake_case key, e.g. "yoga_time" or "contact_sam"'),
    value: z.string().min(1).max(500),
  }),
  async execute(ctx, args) {
    const outside = ctx.influence?.() ?? [];
    if (outside.length) {
      const source = outside.join(', ');
      const row = await upsertFact(ctx.db, ctx.ipersonId, { ...args, pendingFrom: source });
      ctx.onPendingMemory?.({ kind: 'fact', id: row.id, text: row.value, source });
      return { saved: false, pending: true, note: `Not saved yet: it came right after reading ${source}. Ask the user to keep or discard it (they see a Keep / Discard prompt).` };
    }
    const row = await upsertFact(ctx.db, ctx.ipersonId, args);
    return { saved: true, category: row.category, key: row.key };
  },
});
