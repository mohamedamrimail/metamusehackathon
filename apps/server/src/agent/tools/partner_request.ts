import { z } from 'zod';
import { defineTool } from './types.ts';

// Internal: a partner's request (CV, contact, interview…) shown as an approval card. Only the runtime
// runs it, after the user's yes; the model never sees it. The work is done by `fulfil`, set at startup.

export const partnerRequestHandler: { fulfil?: (requestId: string) => Promise<unknown> } = {};

export default defineTool({
  name: 'partner_request',
  description: 'Fulfils a partner request the user approved.',
  risk: 'write',
  internal: true,
  schema: z.object({ request_id: z.uuid() }),
  async execute(_ctx, a) {
    if (!partnerRequestHandler.fulfil) throw new Error('partner requests are not available');
    return partnerRequestHandler.fulfil(a.request_id);
  },
});
