import { createDb } from '../src/db/client.ts';
import { metricsSummary } from '../src/lib/metrics.ts';

// Prints the README "Traction" numbers (real users only) as Markdown, ready to paste.
// Usage: pnpm --filter @ipersons/server metrics:summary

const { db, pool } = createDb();
const m = await metricsSummary(db);
const rows: [string, string | number][] = [
  ['Sign-ups', m.signups], ['WhatsApp-verified users', m.verified], ['Twins with an avatar', m.twins_with_avatar],
  ['Active users (at least one turn)', m.active_users], ['Users active on 2+ days', m.retained_users],
  ['Conversation turns', m.turns], ['Voice minutes', m.voice_minutes],
  ['Actions proposed / approved / declined / expired', `${m.actions_proposed} / ${m.actions_approved} / ${m.actions_declined} / ${m.actions_expired}`],
  ['Hand-off links sent', m.handoffs], ['Public-twin visitor conversations', m.visitor_conversations],
  ['Partner requests / approved', `${m.partner_requests} / ${m.partner_approved}`],
  ['AI cost per active user per day (average / median)', `$${m.cost_per_active_user_day_avg_usd} / $${m.cost_per_active_user_day_median_usd}`],
];
console.log(`## Traction\n\nAs of ${new Date().toISOString().slice(0, 10)}. Real users only: judges, the demo accounts and the team are not counted.\n`);
console.log('| Metric | Value |\n| --- | --- |');
for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
await pool.end();
