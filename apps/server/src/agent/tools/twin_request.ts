import { z } from 'zod';
import { defineTool, type ToolContext } from './types.ts';

// Internal: approval cards from twin-to-twin flows (a connection request, "share 3 possible times?",
// "send these options to Sami?", "Sami picked Wed 16:00 — book it?"). Created by the system, run only by
// the runtime after the owner's yes; the model never sees this tool. The work is done in src/twins/*.

export const TWIN_REQUEST_KINDS = ['connect', 'share_times', 'send_options', 'choose', 'proceed_without', 'confirm', 'suggest'] as const;
const Args = z.object({
  kind: z.enum(TWIN_REQUEST_KINDS),
  connection_id: z.uuid().optional(),
  session_id: z.uuid().optional(),
  participant_id: z.uuid().optional(),
});
export type TwinRequestArgs = z.infer<typeof Args>;

export const twinRequestHandler: { fulfil?: (ctx: ToolContext, args: TwinRequestArgs) => Promise<unknown> } = {};

export default defineTool({
  name: 'twin_request',
  description: 'Runs a twin-to-twin step the owner approved.',
  risk: 'write',
  internal: true,
  schema: Args,
  async execute(ctx, a) {
    if (!twinRequestHandler.fulfil) throw new Error('twin-to-twin is not available');
    return twinRequestHandler.fulfil(ctx, a);
  },
});
