import { resolve } from 'node:path';
import { importSqlite } from '../server/import-sqlite.js';
import { createPostgresStore } from '../server/postgres.js';
if (!process.env.DATABASE_URL || !process.argv[2])
  throw new Error('Usage: DATABASE_URL=... pnpm db:import-sqlite path/to/offline-backup.db');
const target = await createPostgresStore(process.env.DATABASE_URL);
try {
  const counts = await importSqlite(resolve(process.argv[2]), target);
  console.log(JSON.stringify({ event: 'sqlite_import_verified', counts }));
} finally {
  await target.close();
}
