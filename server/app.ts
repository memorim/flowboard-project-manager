import { requestLog, safeError, type LogSink } from './observability.js';
import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase, type Db } from './db.js';
import { asStore, type Store } from './sqlite-adapter.js';
import type { AccountOptions } from './account-routes.js';
import { installMailInvitations } from './workspace-integrations.js';
import { installDirectory } from './directory.js';
import { installBilling, type BillingOptions } from './billing.js';
import { takeBudget } from './rate-limit.js';
import { installSocialLogin, type SocialOptions } from './social-login.js';
import { flowApi, type Actor } from '../src/flow-api.js';
import { authConfiguration, installSessionAuth, sessionActor, type AuthMode } from './auth.js';
export function createApp(
  db: Db | Store = createDatabase(),
  log?: LogSink,
  options: {
    authMode?: AuthMode;
    accounts?: AccountOptions;
    billing?: BillingOptions;
    social?: SocialOptions;
  } = {},
): Express {
  const settings = authConfiguration({
    ...process.env,
    ...(options.authMode ? { FLOW_AUTH_MODE: options.authMode } : {}),
  });
  const app = express(),
    sql = asStore(db);
  const limit = (name: string, fallback: number) => {
    const value = Number(process.env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 10000)
      throw new Error('Invalid ' + name);
    return value;
  };
  sql.limits = {
    changes: limit('FLOW_WRITES_PER_MINUTE', 120),
    workspaces: limit('FLOW_WORKSPACE_QUOTA', 100),
    projects: limit('FLOW_PROJECT_QUOTA', 500),
    invitations: limit('FLOW_INVITATION_QUOTA', 200),
  };
  if (process.env.FLOW_TRUST_PROXY_HOPS) {
    const hops = Number(process.env.FLOW_TRUST_PROXY_HOPS);
    if (!Number.isInteger(hops) || hops < 1 || hops > 3)
      throw new Error('FLOW_TRUST_PROXY_HOPS must be 1..3');
    app.set('trust proxy', hops);
  }
  const revision = /^[a-f0-9]{40}$/i.test(process.env.APP_REVISION || '')
    ? process.env.APP_REVISION
    : 'local-unversioned';
  app.use('/api/health', (_req, res, next) => {
    res.set('X-App-Revision', revision);
    next();
  });

  app.use(requestLog(log));
  app.use(express.text({ type: ['application/json', 'application/scim+json'], limit: '16kb' }));
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.locals.mail = installSessionAuth(app, sql, settings, options.accounts);
  if (settings.mode === 'session')
    installSocialLogin(app, sql, settings, {
      ...options.social,
      key: options.social?.key || options.accounts?.key,
    });
  if (settings.mode === 'session') installMailInvitations(app, sql, settings, app.locals.mail);
  if (settings.mode === 'session') installDirectory(app, sql, settings, app.locals.mail);
  if (settings.mode === 'session')
    app.locals.billing = installBilling(app, sql, settings, options.billing);
  app.use('/api', async (req, res) => {
    if (req.path !== '/health') await takeBudget(sql, 'api:peer:' + req.ip, 600, 60000);
    const actor =
      settings.mode === 'demo'
        ? await sql
            .prepare('SELECT id,name,role,initials,color FROM members WHERE id=?')
            .bind(Number(req.get('X-Demo-Actor') || 4))
            .first<Actor>()
        : await sessionActor(sql, req);
    if (actor && !['GET', 'HEAD', 'OPTIONS'].includes(req.method))
      await takeBudget(sql, 'api:write:' + actor.id, sql.limits!.changes, 60000);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new Request(
      `${settings.publicOrigin || `${req.protocol}://${req.get('host')}`}${req.originalUrl}`,
      {
        method: req.method,
        headers,
        ...(!['GET', 'HEAD'].includes(req.method) && req.body ? { body: req.body } : {}),
      },
    );
    const response = await flowApi(
      request,
      sql,
      actor ?? null,
      settings.mode === 'demo' ? 'local' : 'authenticated',
    );
    res.status(response.status);
    response.headers.forEach((v, n) => res.set(n, v));
    res.send(await response.text());
  });
  const dist = resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  app.use((_req, res) => res.status(404).json({ message: 'Маршрут не найден' }));
  app.use(safeError);
  return app;
}
