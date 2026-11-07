import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.js';
import { asStore } from '../server/sqlite-adapter.js';
import { brevoSender, mailQueue, mailSender, smtpSender } from '../server/mail.js';

test('HTTPS mail survives quota failure and worker restart without losing encrypted instructions', async () => {
  const calls: { id: string; text: string }[] = [];
  const sender = brevoSender(
    {
      BREVO_API_KEY: 'fixture-api-key',
      BREVO_FROM_EMAIL: 'sender@example.test',
      FLOW_PUBLIC_ORIGIN: 'https://flowboard.example.test',
    },
    async (url, options) => {
      assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
      assert.equal(options?.method, 'POST');
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal instanceof AbortSignal);
      assert.equal(new Headers(options?.headers).get('api-key'), 'fixture-api-key');
      const body = JSON.parse(String(options?.body));
      assert.deepEqual(body.sender, { email: 'sender@example.test', name: 'Flowboard' });
      assert.deepEqual(body.to, [{ email: 'recipient@example.test' }]);
      assert.equal(body.subject, 'Account verification');
      calls.push({ id: body.headers['X-Flowboard-Event'], text: body.textContent });
      return calls.length === 1
        ? Response.json({ message: 'quota exceeded' }, { status: 429 })
        : Response.json({ messageId: '<fixture@brevo.test>' }, { status: 201 });
    },
  );
  const db = asStore(createDatabase(':memory:')),
    key = randomBytes(32);
  let queue = mailQueue(db, key, sender);
  try {
    await queue.enqueue({
      to: 'recipient@example.test',
      subject: 'Account verification',
      text: 'https://flowboard.example.test/verify?token=private-fixture',
    });
    await queue.run();
    const waiting = await db
      .prepare('SELECT attempts,delivered_at,payload FROM mail_outbox')
      .first<{ attempts: number; delivered_at: number | null; payload: string }>();
    assert.equal(waiting!.attempts, 1);
    assert.equal(waiting!.delivered_at, null);
    assert.ok(waiting!.payload && !waiting!.payload.includes('private-fixture'));
    await queue.stop();
    queue = mailQueue(db, key, sender);
    await db.prepare('UPDATE mail_outbox SET next_attempt_at=0').run();
    await queue.run();
    const delivered = await db
      .prepare('SELECT attempts,delivered_at,payload FROM mail_outbox')
      .first<{ attempts: number; delivered_at: number; payload: string }>();
    assert.equal(delivered!.attempts, 2);
    assert.ok(delivered!.delivered_at);
    assert.equal(delivered!.payload, '');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].id, calls[1].id);
    assert.match(calls[1].text, /private-fixture/);
    assert.match(calls[1].text, /https:\/\/flowboard\.example\.test\/privacy\.html/);
    await queue.run();
    assert.equal(calls.length, 2);
  } finally {
    await queue.stop();
    await db.close();
  }
});

test('HTTPS mail rejects incomplete acknowledgements and hides provider error details', async () => {
  const env = { BREVO_API_KEY: 'fixture-key', BREVO_FROM_EMAIL: 'sender@example.test' },
    message = {
      id: 'fixture-event',
      to: 'recipient@example.test',
      subject: 'Reset',
      text: 'secret',
    };
  for (const body of [null, {}, { messageId: '' }, { messageId: 42 }]) {
    const send = brevoSender(env, async () => Response.json(body, { status: 201 }));
    await assert.rejects(send(message), /acknowledgement is invalid/);
  }
  const malformed = brevoSender(env, async () => new Response('not-json secret', { status: 201 }));
  await assert.rejects(malformed(message), { message: 'Mail provider acknowledgement is invalid' });
  const rejected = brevoSender(env, async () =>
    Response.json({ message: 'provider echoed fixture-key and secret' }, { status: 401 }),
  );
  await assert.rejects(rejected(message), (error: Error) => {
    assert.equal(error.message, 'Mail provider did not accept the message');
    return true;
  });
});

test('mail configuration keeps SMTP optional and requires explicit valid HTTPS configuration', () => {
  assert.equal(mailSender({}), undefined);
  assert.throws(() => mailSender({ FLOW_MAIL_PROVIDER: 'other' }), /FLOW_MAIL_PROVIDER/);
  assert.throws(() => mailSender({ FLOW_MAIL_PROVIDER: 'brevo' }), /BREVO_API_KEY/);
  assert.throws(
    () => brevoSender({ BREVO_API_KEY: 'fixture', BREVO_FROM_EMAIL: 'name <user@example.test>' }),
    /BREVO_FROM_EMAIL/,
  );
  assert.equal(
    typeof mailSender({
      FLOW_MAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: 'fixture',
      BREVO_FROM_EMAIL: 'sender@example.test',
    }),
    'function',
  );
});

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
      FLOW_PUBLIC_ORIGIN: 'https://flowboard.example.test',
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
    assert.match(received, /https:\/\/flowboard\.example\.test\/privacy\.html/);
    await queue.run();
    assert.equal((received.match(/token-fixture/g) || []).length, 1);
  } finally {
    await queue.stop();
    await db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
