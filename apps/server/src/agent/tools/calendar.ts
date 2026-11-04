import { and, asc, eq, gt, lt } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { calendarEvents } from '../../db/schema.ts';

// HACKATHON: local demo calendar. Swap for Google Calendar when a connection exists.

export function listEvents(db: Db, ipersonId: string, from: Date, to: Date) {
  return db.select().from(calendarEvents)
    .where(and(
      eq(calendarEvents.ipersonId, ipersonId),
      lt(calendarEvents.startsAt, to),
      gt(calendarEvents.endsAt, from),
    ))
    .orderBy(asc(calendarEvents.startsAt));
}

export async function insertEvent(db: Db, ipersonId: string, ev: {
  title: string; startsAt: Date; endsAt: Date; location?: string;
}) {
  const [row] = await db.insert(calendarEvents).values({ ipersonId, ...ev }).returning();
  return row!;
}
