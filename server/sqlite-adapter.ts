import type { Db } from './db.js';
import type { SqlDB, Statement, Result } from '../src/flow-api.js';
export function sqliteAdapter(db: Db): SqlDB {
  const execute = new WeakMap<Statement, () => Result>();
  function statement(sql: string, values: unknown[] = []): Statement {
    const prepared = db.prepare(sql),
      args = values as (string | number | null)[];
    const run = (): Result => {
      const r = prepared.run(...args);
      return {
        results: [],
        meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
      };
    };
    const item: Statement = {
      bind: (...v) => statement(sql, v),
      first: async <T>() => (prepared.get(...args) as T | undefined) ?? null,
      all: async <T>() => ({ results: prepared.all(...args) as T[], meta: {} }),
      run: async () => run(),
    };
    execute.set(
      item,
      /^\s*SELECT\b/i.test(sql)
        ? () => ({ results: prepared.all(...args) as Record<string, unknown>[], meta: {} })
        : run,
    );
    return item;
  }
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map((s) => execute.get(s)!());
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
