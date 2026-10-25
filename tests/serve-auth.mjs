import { createServer } from 'node:http';
import { createApp } from '../server/app.ts';
import { createDatabase } from '../server/db.ts';
import { createAccount } from '../server/auth.ts';

let db, app;
async function reset() {
  db?.close();
  db = createDatabase(':memory:');
  await createAccount(db, {
    email: 'owner@example.test',
    name: 'Session owner',
    password: 'Correct-fixture-password-2026',
  });
  app = createApp(db, () => {});
}
await reset();
// This reset route exists only in this isolated, loopback test fixture.
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/__test/reset') {
    await reset();
    res.writeHead(204).end();
    return;
  }
  app(req, res);
}).listen(4141, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
