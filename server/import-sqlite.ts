import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Store } from './sqlite-adapter.js';
const tables = [
  'members',
  'workspaces',
  'memberships',
  'projects',
  'tasks',
  'activity',
  'invitations',
  'task_history',
  'accounts',
  'sessions',
  'account_actions',
  'mfa_challenges',
  'recovery_codes',
  'request_budgets',
  'mail_outbox',
  'directory_tokens',
  'directory_users',
  'directory_groups',
  'directory_group_members',
  'workspace_payments',
  'workspace_plans',
];
const identities = [
  'members',
  'workspaces',
  'projects',
  'tasks',
  'activity',
  'invitations',
  'task_history',
];
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const fingerprint = (rows: Record<string, unknown>[], columns: string[]) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        rows
          .map((row) => columns.map((column) => row[column]))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
    )
    .digest('hex');
export async function importSqlite(sourceFile: string, target: Store) {
  if (target.dialect !== 'postgres') throw new Error('Import target must be PostgreSQL');
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    source.exec('BEGIN');
    if (
      source.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' ||
      source.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('Source integrity check failed');
    return await target.transaction(async () => {
      await target
        .prepare('SELECT pg_advisory_xact_lock(hashtext(?))')
        .bind('flowboard-import')
        .first();
      for (const table of tables) {
        const count = await target
          .prepare(
            'SELECT COUNT(*) n FROM ' +
              quote(table) +
              (table === 'workspaces' ? ' WHERE id<>1' : ''),
          )
          .first<{ n: number }>();
        if (count!.n) throw new Error('Target must be empty; no existing data may be replaced');
      }
      // Only a fresh target placeholder is removed, inside a transaction. Source is read-only.
      await target.prepare('DELETE FROM workspaces WHERE id=1').run();
      await target.prepare('ALTER TABLE tasks DISABLE TRIGGER USER').run();
      await target.prepare('ALTER TABLE invitations DISABLE TRIGGER USER').run();
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const columns = (
          source.prepare('PRAGMA table_info(' + quote(table) + ')').all() as { name: string }[]
        ).map((c) => c.name);
        if (!columns.length)
          throw new Error('Source must first be upgraded to this version: ' + table);
        // ponytail: offline imports load one table in memory; use COPY streaming for datasets that outgrow RAM.
        const rows = source.prepare('SELECT * FROM ' + quote(table)).all();
        const statement = target.prepare(
          'INSERT INTO ' +
            quote(table) +
            '(' +
            columns.map(quote).join(',') +
            ') VALUES(' +
            columns.map(() => '?').join(',') +
            ')',
        );
        for (const row of rows) await statement.bind(...columns.map((column) => row[column])).run();
        const copied = (
          await target
            .prepare('SELECT ' + columns.map(quote).join(',') + ' FROM ' + quote(table))
            .all()
        ).results;
        if (fingerprint(rows, columns) !== fingerprint(copied, columns))
          throw new Error('Data verification failed: ' + table);
        counts[table] = rows.length;
      }
      for (const table of identities)
        await target
          .prepare(
            "SELECT setval(pg_get_serial_sequence(?, 'id'),GREATEST(1,(SELECT COALESCE(MAX(id),1) FROM " +
              quote(table) +
              ')))',
          )
          .bind(table)
          .first();
      await target.prepare('ALTER TABLE tasks ENABLE TRIGGER USER').run();
      await target.prepare('ALTER TABLE invitations ENABLE TRIGGER USER').run();
      return counts;
    });
  } finally {
    source.close();
  }
}
