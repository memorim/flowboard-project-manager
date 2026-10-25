import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
process.env.NODE_ENV = 'test';
const { createApp } = await import('../server/app.js');
const { createDatabase: createDb } = await import('../server/db.js');

test('smoke checks real HTTP health and fails on a mismatched revision', async () => {
  const previous = process.env.APP_REVISION;
  process.env.APP_REVISION = 'a'.repeat(40);
  const db = createDb(':memory:');
  const server = createApp(db).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const env = {
      ...process.env,
      SMOKE_URL: `http://127.0.0.1:${address.port}`,
      EXPECTED_REVISION: 'a'.repeat(40),
    };
    const result = await promisify(execFile)(process.execPath, ['scripts/smoke.mjs'], { env });
    assert.match(result.stdout, /health_smoke/);
    await assert.rejects(() =>
      promisify(execFile)(process.execPath, ['scripts/smoke.mjs'], {
        env: { ...env, EXPECTED_REVISION: 'b'.repeat(40) },
      }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    if (previous === undefined) delete process.env.APP_REVISION;
    else process.env.APP_REVISION = previous;
  }
});
