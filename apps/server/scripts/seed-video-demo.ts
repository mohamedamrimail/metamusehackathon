import { createDb } from '../src/db/client.ts';
import { buildApp, createDeps } from '../src/index.ts';
import { demoSpendUsd, seedVideoDemo, type PersonaId } from './video-demo-data.ts';

// The video demo accounts Adam, Hana, Sara and Giga (account_kind 'demo', @adam @hana @sara @giga), with the neutral demo
// services. Idempotent: every run resets their conversations, actions and sample data.
// Usage: pnpm --filter @ipersons/server seed:video-demo [--avatars | --redo-avatars[=adam,giga]]
//   --avatars makes Adam's and Giga's avatars if missing (Muse Image + SAM, ~$0.20 each); --redo-avatars remakes them.

const { db, pool } = createDb();
const deps = createDeps(db);
const app = buildApp(deps);
await app.ready();
const redo = process.argv.find((a) => a.startsWith('--redo-avatars'));
const avatars = redo ? (redo.includes('=') ? redo.split('=')[1]!.split(',') as PersonaId[] : 'redo' as const) : process.argv.includes('--avatars');
await seedVideoDemo(app, deps, { avatars });
console.log(`Demo spend so far (provider prices): $${(await demoSpendUsd(db)).toFixed(3)}`);
await app.close();
await pool.end();
