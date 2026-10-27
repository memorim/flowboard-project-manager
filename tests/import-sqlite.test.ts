import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDatabase } from '../server/db.js';
import { createPostgresStore } from '../server/postgres.js';
import { importSqlite } from '../server/import-sqlite.js';
test(
  'offline SQLite import preserves every row, resets identities and refuses a nonempty target',
  { skip: !process.env.FLOW_TEST_DATABASE_URL },
  async () => {
    const url = process.env.FLOW_TEST_DATABASE_URL!,
      schema = 'flow_imp_' + randomUUID().replaceAll('-', '').slice(0, 24),
      folder = mkdtempSync(join(tmpdir(), 'flow-import-')),
      file = join(folder, 'source.db');
    const source = createDatabase(file);
    source.close();
    const target = await createPostgresStore(url, schema);
    try {
      const counts = await importSqlite(file, target);
      assert.equal(counts.tasks, 8);
      assert.equal(counts.members, 4);
      await assert.rejects(importSqlite(file, target), /Target must be empty/);
      const inserted = await target
        .prepare(
          "INSERT INTO members(name,role,initials,color) VALUES('After import','Member','AI','#222222') RETURNING id",
        )
        .first<{ id: number }>();
      assert.ok(inserted!.id > 4);
      assert.equal(
        (await target.prepare('SELECT COUNT(*) n FROM tasks').first<{ n: number }>())!.n,
        8,
      );
    } finally {
      await target.close();
      const pool = new Pool({ connectionString: url });
      try {
        await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
      } finally {
        await pool.end();
      }
      assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
      assert.ok(folder.includes('flow-import-'));
      rmSync(folder, { recursive: true, force: true });
    }
  },
);
