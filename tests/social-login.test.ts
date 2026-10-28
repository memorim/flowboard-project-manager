import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { createDatabase } from '../server/db.js';
import { createAccount } from '../server/auth.js';
import { digest, totp } from '../server/account-crypto.js';
import { socialProviders, type ProviderId } from '../server/social-providers.js';
import { createPostgresStore } from '../server/postgres.js';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const origin = 'https://flowboard.example.test',
  password = 'Fixture-password-28-October-2026';
process.env.FLOW_PUBLIC_ORIGIN = origin;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'fixture',
  use: 'sig',
  alg: 'RS256',
};
const environments = Object.fromEntries(
  ['GOOGLE', 'YANDEX', 'GITHUB', 'TELEGRAM'].flatMap((id) => [
    [`FLOW_${id}_CLIENT_ID`, 'fixture-client'],
    [`FLOW_${id}_CLIENT_SECRET`, 'fixture-secret'],
  ]),
);

function fixture() {
  const db = createDatabase(':memory:');
  let calls = 0,
    defect = '',
    subject = '42',
    expected: URL;
  const providers = socialProviders(environments, async (input, init) => {
    calls++;
    const url = String(input);
    if (url.includes('jwks') || url.endsWith('/certs')) return Response.json({ keys: [jwk] });
    if (url.includes('/token') || url.endsWith('/access_token')) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(
        createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),
        expected.searchParams.get('code_challenge'),
      );
      assert.equal(
        body.get('redirect_uri'),
        origin +
          '/api/auth/oauth/' +
          (expected.hostname === 'accounts.google.com'
            ? 'google'
            : expected.hostname === 'oauth.telegram.org'
              ? 'telegram'
              : expected.hostname === 'github.com'
                ? 'github'
                : 'yandex') +
          '/callback',
      );
      if (defect === 'network') throw new Error('Fixture token endpoint unavailable');
      const issuer =
        expected.hostname === 'accounts.google.com'
          ? 'https://accounts.google.com'
          : 'https://oauth.telegram.org';
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        sub: subject,
        name: 'Provider user',
        iss: defect === 'issuer' ? 'https://wrong.example.test' : issuer,
        aud: defect === 'audience' ? 'other-client' : 'fixture-client',
        iat: now,
        exp: defect === 'expired' ? now - 600 : now + 300,
        nonce: defect === 'nonce' ? 'wrong' : expected.searchParams.get('nonce'),
      };
      const encoded = [{ alg: 'RS256', kid: 'fixture' }, claims]
        .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
        .join('.');
      const signature =
        defect === 'signature'
          ? Buffer.alloc(256)
          : sign('RSA-SHA256', Buffer.from(encoded), keys.privateKey);
      return Response.json({
        access_token: 'fixture-token',
        token_type: 'bearer',
        expires_in: 300,
        ...(['accounts.google.com', 'oauth.telegram.org'].includes(expected.hostname)
          ? { id_token: encoded + '.' + signature.toString('base64url') }
          : {}),
      });
    }
    assert.ok(
      url === 'https://api.github.com/user' || url === 'https://login.yandex.ru/info?format=json',
    );
    return Response.json({
      id: url.includes('github') ? Number(subject) : subject,
      name: 'Provider user',
      email: 'owner@example.test',
    });
  });
  const app = createApp(db, () => {}, {
    accounts: { key: Buffer.alloc(32, 9) },
    social: { providers },
  });
  const cookie = (res: request.Response) =>
    String(
      (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((value: string) =>
        value.startsWith('flowboard_oauth='),
      ),
    ).split(';')[0];
  return {
    db,
    app,
    providers,
    get calls() {
      return calls;
    },
    defect(value: string) {
      defect = value;
    },
    subject(value: string) {
      subject = value;
    },
    async start(provider: ProviderId = 'google') {
      const res = await request(app).get('/api/auth/oauth/' + provider + '/start');
      assert.equal(res.status, 302);
      expected = new URL(res.headers.location);
      assert.equal(expected.searchParams.get('code_challenge_method'), 'S256');
      assert.match(String(res.headers['set-cookie']), /HttpOnly/);
      assert.match(String(res.headers['set-cookie']), /SameSite=Lax/);
      assert.match(String(res.headers['set-cookie']), /Secure/);
      const path =
        '/api/auth/oauth/' +
        provider +
        '/callback?code=fixture-code&state=' +
        expected.searchParams.get('state');
      return { cookie: cookie(res), path, url: expected };
    },
    callback(flow: { cookie: string; path: string }) {
      return request(app).get(flow.path).set('Cookie', flow.cookie);
    },
    expected(value: string) {
      expected = new URL(value);
    },
  };
}
function sessionCookie(res: request.Response) {
  return String(
    (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((value: string) =>
      value.startsWith('flowboard_session='),
    ),
  ).split(';')[0];
}

test(
  'real PostgreSQL: two app instances consume one callback atomically; identity/session survive reopening the database',
  { skip: !process.env.FLOW_TEST_DATABASE_URL },
  async () => {
    const schema = 'flow_oauth_' + randomUUID().replaceAll('-', '').slice(0, 24),
      url = process.env.FLOW_TEST_DATABASE_URL!;
    const first = await createPostgresStore(url, schema),
      second = await createPostgresStore(url, schema),
      f = fixture();
    let reopened: Awaited<ReturnType<typeof createPostgresStore>> | undefined;
    try {
      const options = {
        accounts: { key: Buffer.alloc(32, 9) },
        social: { providers: f.providers },
      };
      const a = createApp(first, () => {}, options),
        b = createApp(second, () => {}, options);
      const start = await request(a).get('/api/auth/oauth/google/start');
      assert.equal(start.status, 302);
      f.expected(start.headers.location);
      const path =
        '/api/auth/oauth/google/callback?code=fixture-code&state=' +
        new URL(start.headers.location).searchParams.get('state');
      const cookie = String(start.headers['set-cookie'][0]).split(';')[0];
      const results = await Promise.all(
        [a, b].map((app) => request(app).get(path).set('Cookie', cookie)),
      );
      assert.deepEqual(results.map((r) => r.headers.location).sort(), [
        '/',
        '/?auth=provider-error',
      ]);
      assert.equal(
        (await first.prepare('SELECT COUNT(*) n FROM external_identities').first<{ n: number }>())!
          .n,
        1,
      );
      assert.equal(
        (await first.prepare('SELECT COUNT(*) n FROM sessions').first<{ n: number }>())!.n,
        1,
      );
      reopened = await createPostgresStore(url, schema);
      const signed = results.find((r) => r.headers.location === '/')!;
      assert.equal(
        (
          await request(createApp(reopened, () => {}, options))
            .get('/api/auth/account')
            .set('Cookie', sessionCookie(signed))
        ).status,
        200,
      );
    } finally {
      await first.close();
      await second.close();
      await reopened?.close();
      f.db.close();
      const pool = new Pool({ connectionString: url });
      try {
        await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
      } finally {
        await pool.end();
      }
    }
  },
);

test('only fully configured providers are offered; partial config fails closed', async () => {
  assert.deepEqual(socialProviders({}), []);
  assert.throws(() => socialProviders({ FLOW_GOOGLE_CLIENT_ID: 'id' }));
  const f = fixture();
  try {
    const response = await request(f.app).get('/api/auth/oauth/providers');
    assert.deepEqual(
      response.body.map((p: { id: string }) => p.id),
      ['google', 'yandex', 'github', 'telegram'],
    );
    assert.doesNotMatch(JSON.stringify(response.body), /secret|fixture-client/);
  } finally {
    f.db.close();
  }
});
test('all four providers use code + PKCE and stable subjects, without granting sample workspace write access', async () => {
  const f = fixture();
  try {
    for (const id of ['google', 'yandex', 'github', 'telegram'] as const) {
      const flow = await f.start(id),
        res = await f.callback(flow);
      assert.equal(res.headers.location, '/');
      const cookie = sessionCookie(res);
      assert.match(cookie, /^[^=]+=[a-f0-9]{64}$/);
      const account = await request(f.app).get('/api/auth/account').set('Cookie', cookie);
      assert.equal(account.status, 200);
      assert.equal(account.body.email, null);
      assert.equal(account.body.hasPassword, false);
      assert.equal(account.body.identities[0].provider, id);
      const session = await request(f.app).get('/api/session').set('Cookie', cookie);
      assert.equal(session.body.canWrite, false);
      assert.equal(
        (
          await request(f.app)
            .post('/api/workspaces')
            .set('Origin', origin)
            .set('Cookie', cookie)
            .send({ name: 'Private ' + id })
        ).status,
        201,
      );
      const repeat = await f.callback(await f.start(id));
      assert.equal(
        (await request(f.app).get('/api/auth/account').set('Cookie', sessionCookie(repeat))).body
          .id,
        account.body.id,
      );
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM external_identities').get()!.n, 4);
    assert.equal(
      f.db
        .prepare('SELECT COUNT(*) n FROM accounts WHERE password_enabled=0 AND email_verified=0')
        .get()!.n,
      4,
    );
    f.db
      .prepare('UPDATE accounts SET email=? WHERE member_id=?')
      .run(
        'external@example.test',
        f.db.prepare('SELECT member_id FROM accounts LIMIT 1').get()!.member_id,
      );
    assert.equal(
      (
        await request(f.app).post('/api/auth/login').set('Origin', origin).send({
          email: 'external@example.test',
          password,
        })
      ).status,
      401,
    );
  } finally {
    f.db.close();
  }
});
test('browser binding, state expiry, cross-provider callback and callback replay reject before token requests', async () => {
  const f = fixture();
  try {
    const flow = await f.start();
    assert.equal((await request(f.app).get(flow.path)).headers.location, '/?auth=provider-error');
    assert.equal(f.calls, 0);
    assert.equal(
      (await f.callback({ ...flow, cookie: 'flowboard_oauth=' + 'a'.repeat(64) })).headers.location,
      '/?auth=provider-error',
    );
    assert.equal(f.calls, 0);
    assert.equal(
      (await f.callback({ ...flow, path: flow.path.replace('/google/', '/github/') })).headers
        .location,
      '/?auth=provider-error',
    );
    assert.equal(f.calls, 0);
    assert.equal((await f.callback(flow)).headers.location, '/');
    const calls = f.calls;
    assert.equal((await f.callback(flow)).headers.location, '/?auth=provider-error');
    assert.equal(f.calls, calls);
    const expired = await f.start();
    f.db.prepare('UPDATE oauth_flows SET expires_at=0').run();
    assert.equal((await f.callback(expired)).headers.location, '/?auth=provider-error');
    assert.equal(f.calls, calls);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get()!.n, 1);
  } finally {
    f.db.close();
  }
});
test('signed OIDC tokens reject wrong nonce, audience, issuer, expiry and signature; failures are never retried', async () => {
  for (const defect of ['nonce', 'audience', 'issuer', 'expired', 'signature', 'network']) {
    const f = fixture();
    try {
      f.defect(defect);
      const flow = await f.start();
      const res = await f.callback(flow);
      assert.equal(res.headers.location, '/?auth=provider-error', defect);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM external_identities').get()!.n, 0, defect);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get()!.n, 0, defect);
      f.defect('');
      assert.equal((await f.callback(flow)).headers.location, '/?auth=provider-error');
    } finally {
      f.db.close();
    }
  }
});
test('account linking needs password and a live original session; profile email never auto-links', async () => {
  const f = fixture();
  try {
    const owner = await createAccount(f.db, {
      email: 'owner@example.test',
      name: 'Owner',
      password,
    });
    const login = await request(f.app)
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ email: 'owner@example.test', password }),
      cookie = sessionCookie(login);
    const external = await f.callback(await f.start('github'));
    const externalId = (
      await request(f.app).get('/api/auth/account').set('Cookie', sessionCookie(external))
    ).body.id;
    assert.notEqual(externalId, owner.id);
    assert.equal(
      (
        await request(f.app)
          .post('/api/auth/oauth/google/link')
          .set('Origin', 'https://attacker.example.test')
          .set('Cookie', cookie)
          .send({ password })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(f.app)
          .post('/api/auth/oauth/google/link')
          .set('Origin', origin)
          .set('Cookie', cookie)
          .send({ password: 'wrong' })
      ).status,
      401,
    );
    const link = await request(f.app)
      .post('/api/auth/oauth/google/link')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ password });
    assert.equal(link.status, 200);
    f.expected(link.body.url);
    const url = new URL(link.body.url),
      flowCookie = String(link.headers['set-cookie'][0]).split(';')[0];
    f.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(cookie.split('=')[1]));
    assert.equal(
      (
        await f.callback({
          path:
            '/api/auth/oauth/google/callback?code=fixture-code&state=' +
            url.searchParams.get('state'),
          cookie: flowCookie,
        })
      ).headers.location,
      '/?auth=provider-error',
    );
    assert.equal(
      f.db.prepare("SELECT COUNT(*) n FROM external_identities WHERE provider='google'").get()!.n,
      0,
    );
  } finally {
    f.db.close();
  }
});
test('social sign-in respects TOTP, replay prevention, recent-auth checks and explicit linking', async () => {
  const f = fixture();
  try {
    const login = await f.callback(await f.start()),
      cookie = sessionCookie(login);
    const setup = await request(f.app)
      .post('/api/auth/mfa/setup')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ password: '' });
    assert.equal(setup.status, 200);
    const enabled = await request(f.app)
      .post('/api/auth/mfa/enable')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ code: totp(setup.body.secret, Math.floor(Date.now() / 30000)) });
    assert.equal(enabled.status, 200);
    const mfa = await f.callback(await f.start());
    assert.equal(mfa.headers.location, '/?auth=provider-mfa');
    assert.equal(sessionCookie(mfa), 'undefined');
    const challengeCookie = String(
      (mfa.headers['set-cookie'] as unknown as string[]).find((c: string) =>
        c.startsWith('flowboard_external_mfa='),
      ),
    ).split(';')[0];
    const challenge = await request(f.app)
      .get('/api/auth/oauth/mfa-challenge')
      .set('Cookie', challengeCookie);
    assert.equal(challenge.status, 200);
    assert.equal(
      (await request(f.app).get('/api/auth/oauth/mfa-challenge').set('Cookie', challengeCookie))
        .body.challenge,
      challenge.body.challenge,
      'StrictMode duplicate reads must not consume the MFA challenge',
    );
    const verified = await request(f.app)
      .post('/api/auth/mfa/verify')
      .set('Origin', origin)
      .send({ challenge: challenge.body.challenge, code: enabled.body.recoveryCodes[0] });
    assert.equal(verified.status, 200);
    assert.equal(
      (
        await request(f.app)
          .post('/api/auth/mfa/verify')
          .set('Origin', origin)
          .send({ challenge: challenge.body.challenge, code: enabled.body.recoveryCodes[1] })
      ).status,
      401,
    );
    const recentCookie = sessionCookie(verified);
    const linked = await request(f.app)
      .post('/api/auth/oauth/github/link')
      .set('Origin', origin)
      .set('Cookie', recentCookie)
      .send({ password: '' });
    assert.equal(linked.status, 200);
    f.expected(linked.body.url);
    const url = new URL(linked.body.url);
    assert.equal(
      (
        await f.callback({
          path:
            '/api/auth/oauth/github/callback?code=fixture-code&state=' +
            url.searchParams.get('state'),
          cookie: String(linked.headers['set-cookie'][0]).split(';')[0],
        })
      ).headers.location,
      '/',
    );
    assert.equal(
      (await request(f.app).get('/api/auth/account').set('Cookie', recentCookie)).body.identities
        .length,
      2,
    );
    f.db.prepare('UPDATE sessions SET created_at=?').run(Date.now() - 301000);
    assert.equal(
      (
        await request(f.app)
          .post('/api/auth/oauth/yandex/link')
          .set('Origin', origin)
          .set('Cookie', recentCookie)
          .send({ password: '' })
      ).status,
      401,
    );
  } finally {
    f.db.close();
  }
});
