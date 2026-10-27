import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.js';
import { asStore } from '../server/sqlite-adapter.js';
import { mailQueue, smtpSender } from '../server/mail.js';

test('real SMTP transport sends queued mail, retries a failure, and clears encrypted payload after acknowledgement', async () => {
  let received = '',
    reject = true;
  const server = createServer((socket) => {
    socket.write('220 fixture ESMTP\r\n');
    let buffer = '',
      data = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            data = false;
            socket.write('250 queued\r\n');
          } else received += line + '\n';
          continue;
        }
        if (/^EHLO|^HELO/i.test(line)) socket.write('250-fixture\r\n250 SIZE 100000\r\n');
        else if (/^MAIL FROM/i.test(line) && reject) {
          reject = false;
          socket.write('451 retry later\r\n');
        } else if (line === 'DATA') {
          data = true;
          socket.write('354 end with dot\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n');
        } else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const db = asStore(createDatabase(':memory:')),
    sender = smtpSender({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String((server.address() as { port: number }).port),
      SMTP_FROM: 'Flowboard <no-reply@example.test>',
    })!,
    key = randomBytes(32);
  let queue = mailQueue(db, key, sender);
  try {
    await queue.enqueue({
      to: 'recipient@example.test',
      subject: 'Queue fixture',
      text: 'One-time instruction token-fixture',
    });
    await queue.run();
    const failed = await db
      .prepare('SELECT attempts,delivered_at,payload FROM mail_outbox')
      .first<{ attempts: number; delivered_at: number | null; payload: string }>();
    assert.equal(failed!.attempts, 1);
    assert.equal(failed!.delivered_at, null);
    assert.ok(!failed!.payload.includes('token-fixture'));
    await queue.stop();
    queue = mailQueue(db, key, sender); // simulate worker restart, same persisted queue
    await db.prepare('UPDATE mail_outbox SET next_attempt_at=0').run();
    await Promise.all([queue.run(), queue.run()]);
    const sent = await db
      .prepare('SELECT attempts,delivered_at,payload FROM mail_outbox')
      .first<{ attempts: number; delivered_at: number; payload: string }>();
    assert.equal(sent!.attempts, 2);
    assert.ok(sent!.delivered_at);
    assert.equal(sent!.payload, '');
    assert.match(received, /token-fixture/);
    assert.match(received, /Message-ID: <flowboard-/i);
    await queue.run();
    assert.equal((received.match(/token-fixture/g) || []).length, 1);
  } finally {
    await queue.stop();
    await db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
