import { z } from 'zod';
import { defineTool } from './types.ts';

// Internal: a visitor's request from the owner's public page (meeting, email, CV), as an approval card.
// Only the runtime runs it after the owner's yes; the model never sees it.

export const visitorRequestHandler: { fulfil?: (args: { conversation_id: string; kind: string; times: string[] }) => Promise<unknown> } = {};

export default defineTool({
  name: 'visitor_request',
  description: 'Fulfils a visitor request the owner approved.',
  risk: 'write',
  internal: true,
  schema: z.object({ conversation_id: z.uuid(), kind: z.enum(['meeting', 'share_email', 'share_cv']), times: z.array(z.string()).max(3).default([]), note: z.string().optional() }),
  async execute(_ctx, a) {
    if (!visitorRequestHandler.fulfil) throw new Error('visitor requests are not available');
    return visitorRequestHandler.fulfil(a);
  },
});
