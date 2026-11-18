import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { startTestServer } from './helpers/server.ts';

let server: Awaited<ReturnType<typeof startTestServer>>;
let cookie = '';
const password = 'integration-password';
before(async () => { server = await startTestServer(); });
after(async () => { await server?.stop(); });

function request(route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.url}${route}`, {
    method, headers: { origin: server.url, cookie, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
}
async function login() {
  const result = await request('/api/login', 'POST', { user: 'reviewer', password });
  assert.equal(result.status, 200);
  cookie = result.headers.get('set-cookie')!.split(';')[0];
}
function openSocket(cookieHeader = cookie) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(server.url.replace('http:', 'ws:'), { origin: server.url, headers: { cookie: cookieHeader } });
    ws.once('error', reject);
    ws.once('message', (raw) => { assert.equal(JSON.parse(String(raw)).t, 'init'); resolve(ws); });
  });
}
function closed(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Revoked socket remained connected')), 2000);
    ws.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

test('HTTP gate blocks unauthenticated API calls and cross-origin writes', async () => {
  assert.equal((await request('/api/config')).status, 401);
  assert.equal((await request('/api/setup', 'POST', {}, { origin: 'http://untrusted.invalid' })).status, 403);
  const status = await new Promise<number>((resolve, reject) => {
    http.get(`${server.url}/api/setup-state`, { headers: { host: `untrusted.invalid:${server.port}` } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode!));
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('only one first account can be created, including overlapping setup requests', async () => {
  const delayedBody = JSON.stringify({ user: 'unexpected', password });
  let delayed: http.ClientRequest;
  const pending = new Promise<number>((resolve, reject) => {
    delayed = http.request(`${server.url}/api/setup`, {
      method: 'POST', headers: { origin: server.url, 'content-type': 'application/json', 'content-length': Buffer.byteLength(delayedBody) },
    }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
    delayed.on('error', reject);
    delayed.flushHeaders();
  });
  // The slow first request reaches the handler before the complete second request.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const response = await request('/api/setup', 'POST', { user: 'reviewer', password });
  assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  delayed!.end(delayedBody);
  assert.equal(await pending, 403);
  const accounts = await (await request('/api/users')).json();
  assert.deepEqual(accounts.users.map((user: { username: string }) => user.username), ['reviewer']);
});

test('config API never exposes MySQL credentials', async () => {
  assert.equal((await request('/api/db/credentials', 'POST', { user: 'tester', password: 'fixture-secret' })).status, 200);
  const result = await request('/api/config');
  const text = await result.text();
  assert.ok(!text.includes('fixture-secret'));
  assert.deepEqual(JSON.parse(text).mysql, { user: 'tester', hasPassword: true });
});

test('malformed and non-object JSON return a client error', async () => {
  for (const body of ['{bad', 'null', '[]', '1']) {
    const response = await fetch(`${server.url}/api/services`, {
      method: 'POST', headers: { origin: server.url, cookie, 'content-type': 'application/json' }, body,
    });
    assert.equal(response.status, 400, body);
  }
});

test('oversized requests return 413 without killing the server', async () => {
  const response = await request('/api/services', 'POST', { name: 'x'.repeat(1_100_000) });
  assert.equal(response.status, 413);
  assert.equal((await request('/api/me')).status, 200);
});

test('import and rescan preserve configuration and avoid duplicate projects', async () => {
  const root = path.join(server.dir, 'workspace');
  const project = path.join(root, 'sample');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'node -e 0' } }));
  assert.equal((await request('/api/folders', 'POST', { path: root, kind: 'root' })).status, 200);
  assert.equal((await request('/api/folders', 'POST', { path: project, kind: 'project' })).status, 200);
  let config = await (await request('/api/config')).json();
  assert.equal(config.projects.length, 1);
  config.projects[0].name = 'Renamed project';
  config.projects[0].apps[0].autostart = null;
  config = await (await request('/api/config', 'PUT', config)).json();
  assert.equal(config.projects[0].name, 'Renamed project');
  assert.equal(config.projects[0].apps[0].autostart, null);
});

test('unknown env files are refused and backup deletion changes only isolated data', async () => {
  assert.equal((await request('/api/env/read', 'POST', { file: path.join(server.dir, 'config.json') })).status, 403);
  const backup = 'fixture-20260101-010101.sql';
  fs.mkdirSync(path.join(server.dir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(server.dir, 'backups', backup), '-- fixture');
  assert.equal((await request('/api/db/delete-backup', 'POST', { file: backup })).status, 200);
  assert.ok(!fs.existsSync(path.join(server.dir, 'backups', backup)));
});

test('browser TypeScript is served as executable JavaScript', async () => {
  const result = await request('/src/net.ts');
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-type')!, /javascript/);
  const body = await result.text();
  assert.ok(!body.includes('import type'));
  assert.ok(!body.includes('Promise<T>'));
});

test('logout immediately disconnects authenticated WebSocket sessions', async (t) => {
  await login();
  const ws = await openSocket();
  t.after(() => ws.terminate());
  const disconnected = closed(ws);
  assert.equal((await request('/api/logout', 'POST')).status, 200);
  await disconnected;
  assert.equal((await request('/api/config')).status, 401);
  await login();
});

test('password reset disconnects existing sockets and revokes HTTP sessions', async (t) => {
  await login();
  const me = await (await request('/api/me')).json();
  const ws = await openSocket();
  t.after(() => ws.terminate());
  const disconnected = closed(ws);
  assert.equal((await request('/api/users/password', 'POST', { id: me.userId, password })).status, 200);
  await disconnected;
  assert.equal((await request('/api/config')).status, 401);
  await login();
});

test('malformed cookies and unknown WebSocket commands cannot crash the server', async (t) => {
  await login();
  const ws = await openSocket(`broken=%; ${cookie}`);
  t.after(() => ws.terminate());
  ws.send(JSON.stringify({ t: '__defineGetter__' }));
  ws.send(JSON.stringify({ t: 'resize', id: 'missing', cols: Infinity, rows: -5 }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await request('/api/me')).status, 200);
});

test('removing a scanned project excludes it until restored; skipping requirements persists', async () => {
  const root = path.join(server.dir, 'ws2');
  const project = path.join(root, 'gone');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'node -e 0' }, dependencies: { x: '1' } }));
  await request('/api/folders', 'POST', { path: root, kind: 'root' });
  let config = await (await request('/api/config')).json();
  const p = config.projects.find((x: { path: string }) => x.path === project);
  assert.equal(p.apps[0].install, 'missing');
  assert.equal((await request('/api/requirements/skip', 'POST', { projectId: 'nope', reqId: 'db', skip: true })).status, 404);
  const skipped = await (await request('/api/requirements/skip', 'POST', { projectId: p.id, reqId: `deps:${p.apps[0].id}`, skip: true })).json();
  assert.deepEqual(skipped.skippedReqs, [`deps:${p.apps[0].id}`]);
  config = await (await request('/api/scan', 'POST', {})).json();
  assert.deepEqual(config.projects.find((x: { id: string }) => x.id === p.id).skippedReqs, [`deps:${p.apps[0].id}`]);
  const reqs = await (await request('/api/requirements', 'POST', { projectId: p.id })).json();
  assert.equal(reqs.find((r: { id: string }) => r.id === `deps:${p.apps[0].id}`).skipped, true);

  assert.equal((await request('/api/projects/remove', 'POST', { id: path.join(root, 'other') })).status, 404);
  config = await (await request('/api/projects/remove', 'POST', { id: p.id })).json();
  assert.ok(!config.projects.some((x: { id: string }) => x.id === p.id));
  assert.deepEqual(config.excluded, [project]);
  config = await (await request('/api/scan', 'POST', {})).json();
  assert.ok(!config.projects.some((x: { id: string }) => x.id === p.id), 'rescan must not resurrect it');
  assert.ok(fs.existsSync(project), 'disk untouched');
  assert.equal((await request('/api/projects/restore', 'POST', { path: path.join(root, 'unknown') })).status, 404);
  config = await (await request('/api/projects/restore', 'POST', { path: project })).json();
  assert.deepEqual(config.excluded, []);
  assert.ok(config.projects.some((x: { id: string }) => x.id === p.id));
});
