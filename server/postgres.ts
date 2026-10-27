import { Pool, types, type PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Statement, Result } from '../src/flow-http.js';
import type { Store } from './sqlite-adapter.js';

types.setTypeParser(20, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error('Database integer exceeds the API numeric range');
  return number;
});
types.setTypeParser(1700, Number);
type Transaction = { client: PoolClient; changes: number; lastId: number };
export function postgresSql(sql: string, values: unknown[], previous = { changes: 0, lastId: 0 }) {
  let text = sql
    .replace(/\bINSERT OR IGNORE INTO\b/gi, 'INSERT INTO')
    .replace(/\bLIKE\b/g, 'ILIKE')
    .replace(/SUM\(t.status='([^']+)'\)/g, "SUM(CASE WHEN t.status='$1' THEN 1 ELSE 0 END)")
    .replace(/\binProgress\b/g, '"inProgress"')
    .replace(
      "json_set(?, '$.id',id,'$.version',1)",
      "(?::jsonb || jsonb_build_object('id',id,'version',1))::text",
    );
  if (/INSERT OR IGNORE INTO/i.test(sql)) text += ' ON CONFLICT DO NOTHING';
  const insertTable = text.match(
    /^\s*INSERT INTO (members|workspaces|projects|tasks|activity|invitations|task_history)\b/i,
  );
  if (insertTable && !/\bRETURNING\b/i.test(text)) text += ' RETURNING id';
  const bound: unknown[] = [];
  let index = 0;
  // Quoted SQL literals/identifiers are preserved; values never become SQL text.
  text = text.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|\?|last_insert_rowid\(\)|changes\(\)/gi,
    (token) => {
      if (token[0] === "'" || token[0] === '"') return token;
      bound.push(
        token === '?'
          ? values[index++]
          : token.toLowerCase() === 'changes()'
            ? previous.changes
            : previous.lastId,
      );
      return '$' + bound.length;
    },
  );
  if (index !== values.length) throw new Error('SQL binding count mismatch');
  return { text, values: bound };
}
export async function createPostgresStore(
  connectionString: string,
  schema = process.env.FLOW_POSTGRES_SCHEMA || 'flowboard',
) {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) throw new Error('Invalid FLOW_POSTGRES_SCHEMA');
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('Expected a PostgreSQL DATABASE_URL');
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    options:
      '-c search_path=' +
      schema +
      ' -c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000',
    application_name: 'flowboard',
  });
  pool.on('error', () =>
    console.error(JSON.stringify({ event: 'database_pool', status: 'unavailable' })),
  );
  const context = new AsyncLocalStorage<Transaction>();
  async function transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (context.getStore()) return operation();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await context.run({ client, changes: 0, lastId: 0 }, operation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  const operations = new WeakMap<Statement, { sql: string; values: unknown[] }>();
  function statement(sql: string, values: unknown[] = []): Statement {
    async function run<T>(): Promise<Result<T>> {
      const state = context.getStore(),
        query = postgresSql(sql, values, state);
      const result = await (state?.client || pool).query(query.text, query.values);
      if (state && result.command !== 'SELECT') state.changes = result.rowCount || 0;
      const id = result.command === 'INSERT' && result.rows[0]?.id;
      if (state && typeof id === 'number') state.lastId = id;
      return {
        results: result.rows as T[],
        meta: {
          changes: result.rowCount || 0,
          ...(typeof id === 'number' ? { last_row_id: id } : {}),
        },
      };
    }
    const item: Statement = {
      bind: (...bound) => statement(sql, bound),
      first: async <T>() => (await run<T>()).results[0] || null,
      all: <T>() => run<T>(),
      run: () => run(),
    };
    operations.set(item, { sql, values });
    return item;
  }
  const store: Store = {
    dialect: 'postgres',
    prepare: (sql) => statement(sql),
    transaction,
    close: () => pool.end(),
    batch: (statements) =>
      transaction(async () => {
        const results: Result[] = [];
        for (const item of statements) {
          const operation = operations.get(item);
          if (!operation) throw new Error('Statement belongs to another database');
          results.push(await statement(operation.sql, operation.values).all());
        }
        return results;
      }),
  };
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS "' + schema + '"');
    await transaction(async () => {
      const client = context.getStore()!.client;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'flowboard-migrations:' + schema,
      ]);
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
      );
      const migrations = [
        ['001_core', readFileSync(new URL('./postgres-schema.sql', import.meta.url), 'utf8')],
        ['002_accounts', readFileSync(new URL('./account-schema.sql', import.meta.url), 'utf8')],
        [
          '003_integrations',
          readFileSync(new URL('./integrations-schema.sql', import.meta.url), 'utf8'),
        ],
      ];
      for (const [version, sql] of migrations) {
        const checksum = createHash('sha256').update(sql).digest('hex');
        const found = await client.query(
          'SELECT checksum FROM schema_migrations WHERE version=$1',
          [version],
        );
        if (found.rows[0]) {
          if (found.rows[0].checksum !== checksum)
            throw new Error('Applied migration checksum mismatch: ' + version);
        } else {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
            version,
            checksum,
          ]);
        }
      }
    });
    return store;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
