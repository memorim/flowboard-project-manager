import type { Db } from './db.js';
import type { SqlDB, Statement, Result } from '../src/flow-api.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Store extends SqlDB {
  dialect: 'sqlite' | 'postgres';
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  close(): void | Promise<void>;
}
const adapters = new WeakMap<Db, Store>();
export function asStore(db: Db | Store): Store {
  return 'dialect' in db ? db : sqliteAdapter(db);
}
export function sqliteAdapter(db: Db): Store {
  const cached = adapters.get(db);
  if (cached) return cached;
  const context = new AsyncLocalStorage<boolean>();
  let pending: Promise<unknown> = Promise.resolve();
  function exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (context.getStore()) return Promise.resolve().then(operation);
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  }
  async function transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (context.getStore()) return operation();
    return exclusive(() =>
      context.run(true, async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await operation();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK');
          throw error;
        }
      }),
    );
  }
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
      first: <T>() => exclusive(() => (prepared.get(...args) as T | undefined) ?? null),
      all: <T>() => exclusive(() => ({ results: prepared.all(...args) as T[], meta: {} })),
      run: () => exclusive(run),
    };
    execute.set(
      item,
      /^\s*SELECT\b/i.test(sql)
        ? () => ({ results: prepared.all(...args) as Record<string, unknown>[], meta: {} })
        : run,
    );
    return item;
  }
  const store: Store = {
    dialect: 'sqlite',
    transaction,
    close: () => db.close(),
    prepare: (sql) => statement(sql),
    batch: (statements) => transaction(async () => statements.map((s) => execute.get(s)!())),
  };
  adapters.set(db, store);
  return store;
}
