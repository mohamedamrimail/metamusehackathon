import { PLAN_TYPES } from '@ipersons/shared';
import { z } from 'zod';
import { findPlaces } from '../../twins/places.ts';
import { defineTool } from './types.ts';

// Real places for a plan: i-persons partner venues first (labelled), then web search results that link
// to a specific page the search returned. Spoken replies name the place; links stay out of speech.

export default defineTool({
  name: 'find_places',
  description: 'Find up to 3 real places for coffee, lunch, dinner, sport or a walk in an area (partner venues are labelled). Each has a link to its page.',
  risk: 'read',
  external: 'web search',
  schema: z.object({
    type: z.enum(PLAN_TYPES),
    area: z.string().max(100).optional().describe('District or city; empty = the user\'s city'),
    constraints: z.string().max(300).optional().describe('e.g. "quiet, vegetarian options"'),
    budget: z.string().max(60).optional(),
  }),
  async execute(ctx, a) {
    return findPlaces(ctx.db, ctx.llm, { type: a.type, area: a.area, timezone: ctx.timezone, constraints: a.constraints ? [a.constraints] : [], budget: a.budget, demo: ctx.demo });
  },
});
