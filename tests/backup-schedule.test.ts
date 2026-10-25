import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, utimes, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../server/db.js';
import { backupSchedule, backupWebhook } from '../server/backup-schedule.js';
test('scheduled copy is verified, preserves manual files and prunes only expired automatic copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-schedule-')),
    source = join(root, 'source.db'),
    directory = join(root, 'copies'),
    db = createDatabase(source);
  db.close();
  const events: object[] = [];
  const schedule = backupSchedule(source, {
    directory,
    retentionDays: 7,
    log: (e) => events.push(e),
  });
  try {
    assert.equal(await schedule.run(), true);
    const first = (await readdir(directory)).find((n) => n.endsWith('.sqlite'))!;
    const old = new Date(Date.now() - 10 * 86400000);
    await utimes(join(directory, first), old, old);
    await writeFile(join(directory, 'manual.sqlite'), 'leave this file');
    await utimes(join(directory, 'manual.sqlite'), old, old);
    assert.equal(await schedule.run(), true);
    const files = await readdir(directory);
    assert.ok(!files.includes(first));
    assert.ok(files.includes('manual.sqlite'));
    const backup = files.find((n) => n.endsWith('.sqlite') && n !== 'manual.sqlite')!;
    const restored = new DatabaseSync(join(directory, backup));
    assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    restored.close();
    assert.equal(schedule.status().activeAlert, false);
    assert.ok(schedule.status().lastSuccess);
  } finally {
    schedule.stop();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
test('failure is persisted and notifies once until recovery; concurrent cycles are skipped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-alert-')),
    events: object[] = [],
    alerts: object[] = [];
  let release: () => void = () => {};
  const wait = new Promise<void>((done) => (release = done));
  const schedule = backupSchedule(join(root, 'missing.db'), {
    directory: join(root, 'copies'),
    log: (e) => events.push(e),
    notify: async (e) => {
      alerts.push(e);
    },
    backup: async () => {
      await wait;
      throw Object.assign(new Error('private-source-path'), { requestId: 'known-backup-id' });
    },
  });
  try {
    const running = schedule.run();
    assert.equal(await schedule.run(), false);
    release();
    assert.equal(await running, false);
    assert.equal(await schedule.run(), false);
    assert.equal(alerts.length, 1);
    assert.equal(schedule.status().activeAlert, true);
    assert.equal(schedule.status().requestId, 'known-backup-id');
    assert.ok(!JSON.stringify(events).includes('private-source-path'));
    const status = JSON.parse(await readFile(join(root, 'copies/status.json'), 'utf8'));
    assert.ok(status.lastFailure);
    assert.equal(status.activeAlert, true);
    assert.throws(() => backupWebhook('http://untrusted.example/'));
    assert.throws(() => backupSchedule('unused', { retentionDays: 0 }));
  } finally {
    schedule.stop();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
