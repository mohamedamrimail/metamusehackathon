// Terminal chat with an i-person: same runtime and confirmation rules as the web and WhatsApp channels.
// Usage: pnpm chat [email]   (default: the seeded demo user merry@i-persons.com)
// Answer a proposal with "yes"/"no", or /approve N, /decline N when several are pending.
import { eq } from 'drizzle-orm';
import { createInterface } from 'node:readline/promises';
import { ActionError, AgentRuntime, type ActionRow } from '../src/agent/runtime.ts';
import { config } from '../src/config.ts';
import { createDb } from '../src/db/client.ts';
import { ipersons, users } from '../src/db/schema.ts';
import { MetaLlm } from '../src/meta/llm.ts';

if (!config.META_API_KEY) {
  console.error('META_API_KEY is empty. Add it to .env at the repo root.');
  process.exit(1);
}

const email = process.argv[2] ?? 'merry@i-persons.com';
const { db, pool } = createDb();
const [row] = await db.select({ ip: ipersons, user: users }).from(ipersons)
  .innerJoin(users, eq(users.id, ipersons.userId)).where(eq(users.email, email));
if (!row) {
  console.error(`No i-person for ${email}. Run: pnpm --filter @ipersons/server seed`);
  process.exit(1);
}

const rt = new AgentRuntime({ db, llm: new MetaLlm() });
const conversationId = await rt.conversationFor(row.ip.id, 'web');
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log(`Talking to ${row.ip.displayName}. Ctrl+C to quit.\n`);

const showProposals = (list: ActionRow[]) => {
  for (const a of list) {
    const amount = a.amountCents != null ? ` — ${(a.amountCents / 100).toFixed(2)} ${a.currency}` : '';
    console.log(`  [${a.risk}] ${a.summary}${amount}  (yes / no)`);
  }
};

for (;;) {
  const text = (await rl.question('you> ')).trim();
  if (!text) continue;
  try {
    const cmd = /^\/(approve|decline)\s*(\d*)$/.exec(text);
    if (cmd) {
      const pending = await rt.pendingActions(row.ip.id, conversationId);
      const target = pending[Number(cmd[2] || 1) - 1];
      if (!target) { console.log('  (no such pending action)'); continue; }
      const { action, followUp } = await rt.decide({ ipersonId: row.ip.id, actionId: target.id, approve: cmd[1] === 'approve' });
      console.log(`  → ${action.status}`);
      if (followUp) { console.log(`i-person> ${followUp.reply}`); showProposals(followUp.proposed); }
      continue;
    }
    const res = await rt.handleUserMessage({ ipersonId: row.ip.id, conversationId, text });
    if (res.decided) console.log(`  → ${res.decided.status}`);
    console.log(`i-person> ${res.reply}`);
    showProposals(res.proposed);
  } catch (err) {
    console.error(err instanceof ActionError ? `  (${err.message})` : err);
  }
}
await pool.end();
