import { z } from 'zod';
import { parseLocal, toLocalIso, weekday } from '../../lib/time.ts';
import { insertEvent } from './calendar.ts';
import { defineTool } from './types.ts';

export default defineTool({
  name: 'calendar_book',
  description: "Add an event to the user's calendar. Needs the user's confirmation.",
  risk: 'write',
  schema: z.object({
    title: z.string().min(1).max(200),
    start: z.string().describe('ISO date-time; no offset = user timezone'),
    end: z.string().describe('ISO date-time; no offset = user timezone'),
    location: z.string().max(200).optional(),
  }),
  summarize(args, ctx) {
    const start = parseLocal(args.start, ctx.timezone);
    const at = toLocalIso(start, ctx.timezone).slice(0, 16).replace('T', ' ');
    return `Book "${args.title}" on ${weekday(start, ctx.timezone)} ${at}${args.location ? ` at ${args.location}` : ''}`;
  },
  async execute(ctx, args) {
    const startsAt = parseLocal(args.start, ctx.timezone);
    const endsAt = parseLocal(args.end, ctx.timezone);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new Error('invalid start or end');
    if (endsAt <= startsAt) throw new Error('end must be after start');
    const ev = await insertEvent(ctx.db, ctx.ipersonId, { title: args.title, startsAt, endsAt, location: args.location });
    return { booked: true, event_id: ev.id, start: toLocalIso(startsAt, ctx.timezone) };
  },
});
