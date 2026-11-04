import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/db/client.ts';

// MIGRATE_DATABASE_URL targets another database (e.g. the test one) without echoing it.
const url = process.env.MIGRATE_DATABASE_URL || undefined;
const { db, pool } = createDb(url);
await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
await pool.end();
console.log('migrations applied');
