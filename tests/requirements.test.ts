import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeSatisfies, fillEnv } from '../requirements.ts';

test('Node requirements compare minor and patch versions', () => {
  for (const [range, version, expected] of [
    ['>=24.15.0', '24.14.0', false], ['>=24.15.0', '24.15.0', true],
    ['^24.15.0', '24.14.0', false], ['^24.15.0', '25.0.0', false],
    ['~24.14.2', '24.14.1', false], ['~24.14.2', '24.14.8', true],
    ['~24.14.2', '24.15.0', false], ['v24.11.0', '24.14.0', false],
    ['<=24.14.0', '24.14.1', false], ['>24', '24.14.0', false],
    ['>24', '25.0.0', true], ['24.x || >=26.1', '26.0.0', false],
    ['24.x || >=26.1', '24.14.0', true], ['^0.2.1', '0.3.0', false],
    ['^0.0.2', '0.0.3', false], ['24.14', '24.14.9', true],
  ] as const) assert.equal(nodeSatisfies(range, version), expected, `${range} on ${version}`);
});

test('unsupported Node syntax remains unknown even alongside a failing supported branch', () => {
  assert.equal(nodeSatisfies('20.x || lts/*', '24.14.0'), null);
  assert.equal(nodeSatisfies('24.x || lts/*', '24.14.0'), true);
  assert.equal(nodeSatisfies('>=24.0.0-beta', '24.14.0'), null);
  assert.equal(nodeSatisfies('24.x.3', '24.14.0'), null);
});

test('filling an existing env preserves secrets and is idempotent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-env-test-'));
  t.after(() => { assert.ok(path.dirname(dir) === os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  const example = path.join(dir, '.env.example');
  fs.writeFileSync(example, 'TOKEN=example\nPORT=3000\n');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=keep-me\n');
  fillEnv(example);
  const first = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(first, /^TOKEN=keep-me\n/);
  assert.match(first, /PORT=3000/);
  assert.equal(fillEnv(example), 'Nothing to add');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), first);
});

test('skipped requirements stay visible but count as unknown', async () => {
  const { checkProject } = await import('../requirements.ts');
  const p = { id: 'x', name: 'x', path: path.join(os.tmpdir(), 'dd-none'), branch: null, icon: null, envFiles: [], db: 'app', apps: [], skippedReqs: ['db'] };
  const [r] = checkProject(p, { listening: {}, databases: ['other'], services: [], needed: [] });
  assert.deepEqual([r.id, r.status, r.skipped, r.fix], ['db', 'unknown', true, undefined]);
  assert.equal(checkProject({ ...p, skippedReqs: [] }, { listening: {}, databases: ['other'], services: [], needed: [] })[0].status, 'fail');
});
