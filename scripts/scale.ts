import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
const db = createDatabase(':memory:');
db.exec('BEGIN');
const insert = db.prepare(
  "INSERT INTO tasks(title,description,status,priority,project_id,assignee_id,due_date,version) VALUES (?,?,'in_progress','medium',1,1,?,1)",
);
for (let i = 0; i < 10000; i++)
  insert.run(
    'Synthetic ' + String(i).padStart(6, '0'),
    'Generated scale fixture',
    new Date(Date.UTC(2030, 0, 1 + (i % 365))).toISOString().slice(0, 10),
  );
db.exec('COMMIT');
const sql =
    'SELECT t.id,t.title,t.due_date FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.workspace_id=? AND t.project_id=? AND t.status=? ORDER BY t.due_date,t.id LIMIT 40',
  args = [1, 1, 'in_progress'];
const indexSql =
    'CREATE INDEX IF NOT EXISTS tasks_project_state_due ON tasks(project_id,status,due_date,id);CREATE INDEX IF NOT EXISTS tasks_project_due ON tasks(project_id,due_date,id);',
  expectedIndex = 'tasks_project_state_due';
const endpoint = '/api/tasks/page',
  options: RequestInit = {};

const measure = () => {
  const times: number[] = [];
  for (let i = 0; i < 60; i++) {
    const start = performance.now();
    const rows = db.prepare(sql).all(...args);
    assert.equal(rows.length, 40);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return {
    p50_ms: Number(times[29].toFixed(4)),
    p95_ms: Number(times[56].toFixed(4)),
    plan: db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args),
  };
};
db.exec('DROP INDEX IF EXISTS tasks_project_state_due;DROP INDEX IF EXISTS tasks_project_due;');
const before = measure();
db.exec(indexSql);
const after = measure();
assert.ok(after.plan.some((row) => String(row.detail).includes(expectedIndex)));
const server = createApp(db).listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
try {
  const one = await (await fetch(origin + endpoint + '?limit=40&offset=0', options)).json(),
    two = await (await fetch(origin + endpoint + '?limit=40&offset=40', options)).json();
  assert.ok(one.total >= 10000);
  assert.equal(one.items.length, 40);
  assert.equal(two.items.length, 40);
  assert.equal(
    one.items.some((a: { id: number }) => two.items.some((b: { id: number }) => b.id === a.id)),
    false,
  );
  for (const invalid of ['limit=101', 'offset=-1', 'limit=bad', 'status=unknown'])
    assert.equal((await fetch(origin + endpoint + '?' + invalid, options)).status, 400);
  const filtered = await (
    await fetch(origin + endpoint + '?limit=10&search=Synthetic%20009999', options)
  ).json();
  assert.equal(filtered.total, 1);
  const report = {
    kind: 'synthetic-sqlite-scale',
    date: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    synthetic_records: 10000,
    page_size: 40,
    non_overlapping_pages: true,
    filtered_matches: filtered.total,
    before,
    after,
    limits:
      'Fresh in-memory SQLite; query microbenchmark and loopback API correctness, not hosted capacity or real users.',
  };
  await writeFile('docs/SCALE_METRICS.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
}
