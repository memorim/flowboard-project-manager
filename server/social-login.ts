import { randomBytes, randomUUID } from 'node:crypto';
import * as oidc from 'openid-client';
import type { Express, Request, Response } from 'express';
import type { Store } from './sqlite-adapter.js';
import { HttpError } from '../src/flow-http.js';
import {
  confirmCredentials,
  requireActor,
  sessionToken,
  input,
  lockRows,
  establishSession,
  setSession,
  type AuthSettings,
} from './auth.js';
import {
  digest,
  randomToken,
  encrypt,
  decrypt,
  encryptionKey,
  requireKey,
} from './account-crypto.js';
import { takeBudget } from './rate-limit.js';
import { socialProviders, type SocialProvider } from './social-providers.js';
import { z } from 'zod';
export type SocialOptions = { key?: Buffer; providers?: SocialProvider[] };
type Flow = {
  provider: string;
  browser_hash: string;
  verifier: string;
  nonce: string;
  member_id: number | null;
  session_hash: string | null;
  password_version: number | null;
};
const flowCookie = 'flowboard_oauth',
  mfaCookie = 'flowboard_external_mfa';
export function installSocialLogin(
  app: Express,
  db: Store,
  settings: AuthSettings,
  options: SocialOptions = {},
) {
  const key = options.key || encryptionKey(),
    providers = options.providers || socialProviders();
  const available = key && settings.publicOrigin ? providers : [];
  if (providers.length && (!key || !settings.publicOrigin))
    throw new Error('Social sign-in requires FLOW_APP_KEY and FLOW_PUBLIC_ORIGIN');
  const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  const cookieOptions = {
    httpOnly: true,
    secure: settings.secureCookies,
    sameSite: 'lax' as const,
    path: '/api/auth/oauth',
    maxAge: 600000,
  };
  const provider = (id: string) => {
    const found = available.find((p) => p.id === id);
    if (!found) throw new HttpError(404, 'Способ входа не подключён');
    return found;
  };
  const readCookie = (req: Request, name: string) =>
    req.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(name + '='))
      ?.slice(name.length + 1) || '';
  async function start(req: Request, res: Response, link: boolean) {
    const selected = provider(String(req.params.provider));
    await takeBudget(db, 'oauth-start:' + req.ip, 20, 600000);
    let memberId: number | null = null,
      sessionHash: string | null = null,
      version: number | null = null;
    if (link) {
      const actor = await requireActor(db, req),
        data = input(req, z.object({ password: z.string().max(128).default('') }).strict());
      const account = await q(
        'SELECT member_id,password_enabled,password_salt,password_hash,password_version FROM accounts WHERE member_id=?',
        actor.id,
      ).first<{
        member_id: number;
        password_enabled: number;
        password_salt: string;
        password_hash: string;
        password_version: number;
      }>();
      if (!account || !(await confirmCredentials(db, req, account, data.password)))
        throw new HttpError(401, 'Подтвердите пароль или повторно войдите через провайдера');
      memberId = actor.id;
      sessionHash = digest(sessionToken(req)!);
      version = account.password_version;
    }
    const state = randomToken(),
      browser = randomToken(),
      verifier = oidc.randomPKCECodeVerifier(),
      nonce = randomToken();
    await q('DELETE FROM oauth_flows WHERE expires_at<=?', Date.now()).run();
    await q(
      'INSERT INTO oauth_flows(state_hash,provider,browser_hash,verifier,nonce,expires_at,member_id,session_hash,password_version) VALUES(?,?,?,?,?,?,?,?,?)',
      digest(state),
      selected.id,
      digest(browser),
      encrypt(verifier, requireKey(key)),
      nonce,
      Date.now() + 600000,
      memberId,
      sessionHash,
      version,
    ).run();
    const parameters = {
      redirect_uri: settings.publicOrigin + '/api/auth/oauth/' + selected.id + '/callback',
      scope: selected.scope,
      response_type: 'code',
      state,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      ...(selected.oidc ? { nonce } : {}),
    };
    const url = oidc.buildAuthorizationUrl(selected.config, parameters);
    res.cookie(flowCookie, browser, cookieOptions);
    if (link) res.json({ url: url.href });
    else res.redirect(url.href);
  }
  app.get('/api/auth/oauth/providers', (_req, res) =>
    res.json(available.map(({ id, label }) => ({ id, label }))),
  );
  app.get('/api/auth/oauth/mfa-challenge', (req, res) => {
    const challenge = readCookie(req, mfaCookie);
    if (!/^[a-f0-9]{64}$/.test(challenge))
      throw new HttpError(401, 'Повторите вход через провайдера');
    res.json({ challenge });
  });
  app.get('/api/auth/oauth/:provider/start', (req, res) => start(req, res, false));
  app.post('/api/auth/oauth/:provider/link', (req, res) => start(req, res, true));
  app.get('/api/auth/oauth/:provider/callback', async (req, res) => {
    res.clearCookie(flowCookie, cookieOptions);
    try {
      const selected = provider(String(req.params.provider));
      await takeBudget(db, 'oauth-callback:' + req.ip, 30, 600000);
      const state = req.query.state,
        browser = readCookie(req, flowCookie);
      if (
        typeof state !== 'string' ||
        !/^[a-f0-9]{64}$/.test(state) ||
        !/^[a-f0-9]{64}$/.test(browser)
      )
        throw new Error('Missing browser-bound state');
      const flow = await q(
        'UPDATE oauth_flows SET consumed_at=? WHERE state_hash=? AND provider=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>? RETURNING *',
        Date.now(),
        digest(state),
        selected.id,
        digest(browser),
        Date.now(),
      ).first<Flow>();
      if (!flow) throw new Error('Expired or replayed flow');
      const callback = new URL(settings.publicOrigin! + req.originalUrl);
      const tokens = await oidc.authorizationCodeGrant(selected.config, callback, {
        expectedState: state,
        pkceCodeVerifier: decrypt(flow.verifier, requireKey(key)),
        ...(selected.oidc ? { expectedNonce: flow.nonce, idTokenExpected: true } : {}),
      });
      const profile = await selected.profile(tokens);
      const result = await db.transaction(async () => {
        // The provider subject is the identity. Email/name matches never link accounts.
        const existing = await q(
          'SELECT member_id FROM external_identities WHERE provider=? AND subject=?',
          selected.id,
          profile.subject,
        ).first<{ member_id: number }>();
        let member = existing?.member_id;
        if (flow.member_id) {
          const valid = await q(
            'SELECT a.member_id FROM accounts a JOIN sessions s ON s.member_id=a.member_id WHERE a.member_id=? AND a.password_version=? AND s.token_hash=? AND s.expires_at>?' +
              (db.dialect === 'postgres' ? ' FOR UPDATE OF a' : ''),
            flow.member_id,
            flow.password_version,
            flow.session_hash,
            Date.now(),
          ).first();
          if (!valid || (existing && existing.member_id !== flow.member_id))
            throw new Error('Link confirmation expired or identity belongs to another account');
          member = flow.member_id;
        }
        if (!member) {
          // No provider password or fabricated verified email is created.
          member = (await q(
            "INSERT INTO members(name,role,initials,color) VALUES(?,'Участник',?,'#7c64e3') RETURNING id",
            profile.name,
            Array.from(profile.name).slice(0, 2).join('').toUpperCase(),
          ).first<{ id: number }>())!.id;
          await q(
            'INSERT INTO accounts(member_id,email,password_salt,password_hash,email_verified,password_enabled) VALUES(?,?,?,?,0,0)',
            member,
            'external-' + randomUUID() + '@identity.flowboard.invalid',
            randomBytes(16).toString('hex'),
            randomBytes(64).toString('hex'),
          ).run();
        }
        await q(
          'INSERT INTO external_identities(provider,subject,member_id,label,created_at) VALUES(?,?,?,?,?) ON CONFLICT(provider,subject) DO NOTHING',
          selected.id,
          profile.subject,
          member,
          profile.name,
          Date.now(),
        ).run();
        const saved = await q(
          'SELECT member_id FROM external_identities WHERE provider=? AND subject=?',
          selected.id,
          profile.subject,
        ).first<{ member_id: number }>();
        if (saved?.member_id !== member) throw new Error('Concurrent identity link conflict');
        if (flow.member_id) return { linked: true } as const;
        const account = (await q(
          'SELECT password_version,mfa_secret FROM accounts WHERE member_id=?' + lockRows(db),
          member,
        ).first<{ password_version: number; mfa_secret: string | null }>())!;
        if (account.mfa_secret) {
          const challenge = randomToken();
          await q(
            'INSERT INTO mfa_challenges(token_hash,member_id,expires_at,password_version) VALUES(?,?,?,?)',
            digest(challenge),
            member,
            Date.now() + 300000,
            account.password_version,
          ).run();
          return { challenge } as const;
        }
        return {
          token: await establishSession(db, req, member, account.password_version),
        } as const;
      });
      if ('token' in result && result.token) setSession(res, settings, result.token);
      if ('challenge' in result) {
        res.cookie(mfaCookie, result.challenge, cookieOptions);
        return res.redirect('/?auth=provider-mfa');
      }
      return res.redirect('/');
    } catch {
      console.warn(
        JSON.stringify({
          event: 'oauth_sign_in_failed',
          provider: available.some((item) => item.id === req.params.provider)
            ? req.params.provider
            : 'unknown',
        }),
      );
      res.redirect('/?auth=provider-error');
    }
  });
}
