import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.FLOWBOARD_TEST_URL || 'http://127.0.0.1:5178';
const auth = { Cookie: '__sites_local_auth=1', 'Content-Type': 'application/json' };
const request = (path, options = {}) => fetch(base + path, options);
test('D1 persistence, dispatch identity, validation and atomic activity', async () => {
  assert.match(new URL(base).hostname, /^(127\.0\.0\.1|localhost)$/, 'local mock test only');
  const initial = await request('/api/tasks');
  assert.equal(initial.status, 200);
  const session = await (await request('/api/session')).json();
  assert.equal(session.user, null);
  const spoof = await request('/api/tasks', {
    method: 'POST',
    headers: {
      'X-Demo-Actor': '1',
      'oai-authenticated-user-id': 'forged',
      'oai-authenticated-user-email': 'forged@example.com',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(spoof.status, 401);
  const user = await (await request('/api/session', { headers: auth })).json();
  assert.ok(user.user.id);
  assert.equal(user.mode, 'chatgpt');
  assert.equal((await request('/api/tasks?project=bad')).status, 400);
  assert.equal(
    (
      await request('/api/tasks', {
        method: 'POST',
        headers: { ...auth, Origin: 'https://invalid.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('/api/tasks', { method: 'POST', headers: auth, body: '{' })).status,
    400,
  );
  assert.equal(
    (
      await request('/api/tasks', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ x: 'x'.repeat(17000) }),
      })
    ).status,
    413,
  );
  const payload = {
    title: 'Integration ' + Date.now(),
    description: 'Disposable local fixture',
    status: 'todo',
    priority: 'medium',
    projectId: 1,
    assigneeId: null,
    dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  };
  assert.equal(
    (
      await request('/api/tasks', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ...payload, projectId: 999999 }),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request('/api/tasks', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ...payload, admin: true }),
      })
    ).status,
    400,
  );
  const created = await request('/api/tasks', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(payload),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  try {
    assert.ok((await (await request('/api/tasks')).json()).some((t) => t.id === id));
    assert.equal(
      (
        await request('/api/tasks/' + id + '/status', {
          method: 'PATCH',
          headers: auth,
          body: '{}',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request('/api/tasks/' + id, {
          method: 'PATCH',
          headers: auth,
          body: JSON.stringify({ ...payload, title: payload.title + ' edited' }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request('/api/tasks/' + id + '/status', {
          method: 'PATCH',
          headers: auth,
          body: JSON.stringify({ status: 'done' }),
        })
      ).status,
      200,
    );
    const current = (await (await request('/api/tasks')).json()).find((t) => t.id === id);
    assert.equal(current.status, 'done');
    const dashboard = await (await request('/api/dashboard')).json();
    assert.ok(
      dashboard.activity.some(
        (a) => a.member_id === user.user.id && a.text.includes(payload.title),
      ),
    );
  } finally {
    assert.equal(
      (await request('/api/tasks/' + id, { method: 'DELETE', headers: auth })).status,
      204,
    );
  }
});
