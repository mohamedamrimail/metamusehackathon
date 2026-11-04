import { z } from 'zod';
import { parseLocal, toLocalIso } from '../../lib/time.ts';
import { listEvents } from './calendar.ts';
import { defineTool } from './types.ts';

const dateTime = z.string().describe('ISO date-time; no offset = user timezone');

export default defineTool({
  name: 'calendar_list',
  description: "List the user's calendar events between two ISO date-times (user's timezone if no offset).",
  risk: 'read',
  schema: z.object({ from: dateTime, to: dateTime }),
  async execute(ctx, args) {
    const from = parseLocal(args.from, ctx.timezone);
    const to = parseLocal(args.to, ctx.timezone);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('invalid from or to');
    const events = await listEvents(ctx.db, ctx.ipersonId, from, to);
    return {
      events: events.map((e) => ({
        title: e.title,
        start: toLocalIso(e.startsAt, ctx.timezone),
        end: toLocalIso(e.endsAt, ctx.timezone),
        location: e.location ?? undefined,
      })),
    };
  },
});
