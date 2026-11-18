import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Project, Service, TermMeta } from '../types.ts';
import type { TermView } from '../public/src/state.ts';

// state.ts registers a handler on `window` when imported; give Node one before loading it.
(globalThis as { window?: unknown }).window ??= {};
const { state, persist, visibleProjects, toggleFavorite, statusOf, serviceState, serviceUrl } = await import('../public/src/state.ts');

const project = (id: string, hidden = false): Project => ({
  id, name: id, path: id, apps: [], hidden, branch: null, icon: null, envFiles: [], db: null,
});
const service: Service = { id: 'svc', name: 'Example', cmd: 'server.exe', stopCmd: '', cwd: '', port: 8080, url: '', logs: [], autostart: false };
const term = (projectId: string, patch: Partial<TermMeta> = {}): TermMeta => ({
  id: projectId, projectId, title: projectId, status: 'running', code: null, port: null, killed: false, ...patch,
});

beforeEach(() => {
  state.config.projects = [project('alpha'), project('beta'), project('gamma'), project('hidden', true)];
  state.terms.clear();
  state.favorites.clear();
  state.query = '';
  state.projectFilter = 'all';
  state.showHidden = false;
  state.selected = null;
  state.health = {};
});
const addTerm = (meta: TermMeta) => state.terms.set(meta.id, { meta } as TermView);
const ids = () => visibleProjects().map((p) => p.id);

test('favorites move to the top without mutating server project order', () => {
  toggleFavorite('gamma');
  assert.deepEqual(ids(), ['gamma', 'alpha', 'beta']);
  assert.deepEqual(state.config.projects.map((p) => p.id), ['alpha', 'beta', 'gamma', 'hidden']);
  toggleFavorite('missing-project');
  assert.deepEqual([...state.favorites], ['gamma']);
  toggleFavorite('gamma');
  assert.deepEqual(ids(), ['alpha', 'beta', 'gamma']);
});

test('favorites and filter are persisted per browser', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  toggleFavorite('beta');
  state.projectFilter = 'error';
  persist();
  assert.deepEqual(JSON.parse(values.get('favorite-projects')!), ['beta']);
  assert.equal(JSON.parse(values.get('project-filter')!), 'error');
  toggleFavorite('beta');
  assert.deepEqual(JSON.parse(values.get('favorite-projects')!), []);
});

test('status filters combine with favorites and project search', () => {
  addTerm(term('alpha'));
  addTerm(term('beta', { status: 'exited', code: 1 }));
  toggleFavorite('gamma');
  state.projectFilter = 'running';
  assert.deepEqual(ids(), ['alpha']);
  state.projectFilter = 'error';
  assert.deepEqual(ids(), ['beta']);
  state.projectFilter = 'stopped';
  assert.deepEqual(ids(), ['gamma']);
  state.query = '  BETA  ';
  assert.deepEqual(ids(), []);
  state.projectFilter = 'all';
  assert.deepEqual(ids(), ['beta']);
});

test('hidden projects remain hidden unless selected or explicitly shown', () => {
  toggleFavorite('hidden');
  assert.deepEqual(ids(), ['alpha', 'beta', 'gamma']);
  state.selected = 'hidden';
  assert.equal(ids()[0], 'hidden');
  state.selected = null;
  state.showHidden = true;
  assert.equal(ids()[0], 'hidden');
});

test('unknown exit code and intentional termination are not crashes', () => {
  assert.equal(statusOf([term('a', { status: 'exited', code: null })]), '');
  assert.equal(statusOf([term('a', { status: 'exited', code: 1, killed: true })]), '');
  assert.equal(statusOf([term('a', { status: 'exited', code: 1 })]), 'error');
  assert.equal(statusOf([term('a', { status: 'exited', code: 1 }), term('b')]), 'running');
});

test('foreign port owner takes precedence over a service shell still running', () => {
  addTerm(term('services', { serviceId: service.id }));
  state.health[8080] = { pid: 123, foreign: true, name: 'other-server' };
  assert.equal(serviceState(service), 'busy');
  state.health[8080] = { pid: 123, name: 'server' };
  assert.equal(serviceState(service), 'running');
  state.terms.clear();
  assert.equal(serviceState(service), 'external');
});

test('service addresses resolve to the host PC from a LAN client', () => {
  const base = 'http://192.168.1.20:4321/';
  assert.equal(serviceUrl({ ...service, url: 'http://localhost:8080/admin' }, base), 'http://192.168.1.20:8080/admin');
  assert.equal(serviceUrl({ ...service, url: '/phpmyadmin/' }, base), 'http://192.168.1.20:4321/phpmyadmin/');
  assert.equal(serviceUrl({ ...service, url: 'https://example.com/tool' }, base), 'https://example.com/tool');
  assert.equal(serviceUrl({ ...service, url: 'javascript:alert(1)' }, base), null);
  assert.equal(serviceUrl(service, base), null);
});
