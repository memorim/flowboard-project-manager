import { createServer } from 'node:http';
import { createApp } from '../server/app.ts';
import { createDatabase } from '../server/db.ts';
import { createAccount } from '../server/auth.ts';
import { randomBytes } from 'node:crypto';

process.env.FLOW_PUBLIC_ORIGIN = 'http://127.0.0.1:4141';
let db,
  app,
  messages = [];
async function reset() {
  db?.close();
  db = createDatabase(':memory:');
  messages = [];
  await createAccount(db, {
    email: 'owner@example.test',
    name: 'Session owner',
    password: 'Correct-fixture-password-2026',
  });
  app = createApp(db, () => {}, {
    accounts: {
      key: randomBytes(32),
      sendMail: async (mail) => {
        messages.push(mail);
      },
    },
  });
}
await reset();
// This reset route exists only in this isolated, loopback test fixture.
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/__test/messages') {
    await app.locals.mail.run();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(messages));
    return;
  }
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
