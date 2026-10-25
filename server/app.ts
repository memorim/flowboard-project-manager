import { requestLog, safeError, type LogSink } from './observability.js';
import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase, type Db } from './db.js';
import { sqliteAdapter } from './sqlite-adapter.js';
import { flowApi, type Actor } from '../src/flow-api.js';
import { authConfiguration, installSessionAuth, sessionActor, type AuthMode } from './auth.js';
export function createApp(
  db: Db = createDatabase(),
  log?: LogSink,
  options: { authMode?: AuthMode } = {},
): Express {
  const settings = authConfiguration({
    ...process.env,
    ...(options.authMode ? { FLOW_AUTH_MODE: options.authMode } : {}),
  });
  const app = express(),
    sql = sqliteAdapter(db);
  app.use(requestLog(log));
  app.use(express.text({ type: 'application/json', limit: '16kb' }));
  installSessionAuth(app, db, settings);
  app.use('/api', async (req, res) => {
    const actor =
      settings.mode === 'demo'
        ? (db
            .prepare('SELECT id,name,role,initials,color FROM members WHERE id=?')
            .get(Number(req.get('X-Demo-Actor') || 4)) as Actor | undefined)
        : sessionActor(db, req);
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
