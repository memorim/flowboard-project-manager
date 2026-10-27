import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const base = process.env.FLOW_SMOKE_URL || 'http://127.0.0.1:4100',
  mailpit = process.env.FLOW_MAILPIT_URL || 'http://127.0.0.1:8025';
for (const value of [base, mailpit])
  assert.equal(
    new URL(value).hostname,
    '127.0.0.1',
    'This smoke writes fixtures and is restricted to loopback',
  );
const email = 'compose-' + Date.now() + '@example.test',
  password = randomBytes(24).toString('hex');
let cookie = '';
async function call(path, body) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, path + ' returned ' + response.status);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response.json();
}
assert.equal((await call('/api/health')).status, 'ok');
assert.equal((await call('/api/auth/config')).registration, true);
await call('/api/auth/register', { name: 'Compose smoke', email, password });
let token;
for (let attempt = 0; attempt < 50 && !token; attempt++) {
  const result = await (await fetch(mailpit + '/api/v1/messages')).json();
  const message = result.messages.find((message) => message.To.some((to) => to.Address === email));
  if (message) {
    const data = await (await fetch(mailpit + '/api/v1/message/' + message.ID)).json();
    const link = data.Text.match(/http:\/\/\S+/)?.[0];
    if (link) {
      assert.equal(new URL(link).origin, base);
      token = new URL(link).searchParams.get('token');
    }
  }
  if (!token) await new Promise((resolve) => setTimeout(resolve, 300));
}
assert.ok(token, 'SMTP verification message not received');
await call('/api/auth/verify-email', { token, password });
await call('/api/auth/login', { email, password });
assert.ok(cookie.startsWith('flowboard_session='));
const workspace = await call('/api/workspaces', { name: 'Compose smoke workspace' });
const meta = await call('/api/meta?workspace=' + workspace.id);
const task = await call('/api/tasks?workspace=' + workspace.id, {
  title: 'Docker persistence smoke',
  description: '',
  status: 'todo',
  priority: 'medium',
  projectId: meta.projects[0].id,
  assigneeId: null,
  dueDate: '2030-01-10',
});
assert.ok(task.id);
assert.equal((await call('/api/auth/account')).email, email);
console.log(
  JSON.stringify({
    check: 'compose_smtp_registration_login_task',
    status: 'ok',
    workspaceId: workspace.id,
    taskId: task.id,
  }),
);
