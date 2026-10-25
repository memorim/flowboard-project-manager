// Existing role/business fixtures explicitly use the restricted development identity adapter.
import { createApp as application } from '../server/app.js';
import type { Db } from '../server/db.js';
import type { LogSink } from '../server/observability.js';
export function createApp(db: Db, log?: LogSink) {
  return application(db, log, { authMode: 'demo' });
}
