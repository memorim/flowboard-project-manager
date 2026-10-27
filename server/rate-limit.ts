import type { Store } from './sqlite-adapter.js';
import { digest } from './account-crypto.js';
import { HttpError } from '../src/flow-http.js';

// Atomic database admission: all processes/replicas using the same DB share the budget.
export async function takeBudget(
  db: Store,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
) {
  const bucket = Math.floor(now / windowMs),
    expires = (bucket + 1) * windowMs;
  await db.prepare('DELETE FROM request_budgets WHERE expires_at<=?').bind(now).run();
  const result = await db
    .prepare(
      'INSERT INTO request_budgets(budget_key,hits,expires_at) VALUES(?,1,?) ON CONFLICT(budget_key) DO UPDATE SET hits=request_budgets.hits+1 WHERE request_budgets.hits<? RETURNING hits',
    )
    .bind(digest(key + ':' + bucket), expires, limit)
    .first();
  if (!result) throw new HttpError(429, 'Слишком много запросов. Повторите позднее.');
}
