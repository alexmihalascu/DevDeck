import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAll, merge } from '../scan.ts';

test('workspace and manual imports do not duplicate a project', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-scan-test-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const project = path.join(root, 'app');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'node .' } }));
  const found = scanAll({ roots: [root, root], manual: [project, `${project}${path.sep}`] });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, project);
  if (process.platform === 'win32') assert.equal(scanAll({ manual: [project, project.toUpperCase()] }).length, 1);
  const edited = { ...found[0], name: 'Custom', hidden: true, bootStart: true, apps: found[0].apps.map((a) => ({ ...a, autostart: null })) };
  const refreshed = merge([edited], scanAll({ roots: [root] }))[0];
  assert.equal(refreshed.name, 'Custom');
  assert.equal(refreshed.hidden, true);
  assert.equal(refreshed.bootStart, true);
  assert.equal(refreshed.apps[0].autostart, null);
});

test('excluded folders stay out of scans, missing node_modules is still a project, skippedReqs survive merge', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-scan-test-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  for (const n of ['a', 'b']) {
    fs.mkdirSync(path.join(root, n));
    fs.writeFileSync(path.join(root, n, 'package.json'), JSON.stringify({ scripts: { dev: 'x' }, dependencies: { left: '1' } }));
  }
  const all = scanAll({ roots: [root] });
  assert.deepEqual(all.map((p) => p.name).sort(), ['a', 'b']);
  assert.equal(all[0].apps[0].install, 'missing');
  const rest = scanAll({ roots: [root], manual: [path.join(root, 'a')], excluded: [path.join(root, 'a')] });
  assert.deepEqual(rest.map((p) => p.name), ['b']);
  assert.deepEqual(merge([{ ...all[0], skippedReqs: ['db'] }], all)[0].skippedReqs, ['db']);
});
