import { z } from 'zod';
import { FACT_CATEGORIES, listFacts } from '../memory.ts';
import { defineTool } from './types.ts';

export default defineTool({
  name: 'get_profile',
  description: 'Read what you know about the user, optionally one category.',
  risk: 'read',
  schema: z.object({ category: z.enum(FACT_CATEGORIES).optional() }),
  async execute(ctx, args) {
    const facts = await listFacts(ctx.db, ctx.ipersonId, { category: args.category, limit: 200 });
    return { facts: facts.map((f) => ({ category: f.category, key: f.key, value: f.value })) };
  },
});
