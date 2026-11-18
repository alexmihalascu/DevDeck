import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { commit, diff, findExe, parseStatus, remote, status } from '../git.ts';

const binary = findExe('git') || 'git';
function repository(t: TestContext, initial = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-git-test-'));
  const run = (...args: string[]) => execFileSync(binary, args, {
    cwd: dir, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  }).trim();
  t.after(() => {
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('devdeck-git-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'Devdeck tests');
  run('config', 'user.email', 'devdeck-tests@example.invalid');
  run('config', 'commit.gpgsign', 'false');
  run('config', 'core.autocrlf', 'false');
  run('config', 'core.hooksPath', path.join(dir, 'no-hooks'));
  const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
  if (initial) {
    write('selected.txt', 'original selected\n');
    write('other.txt', 'original other\n');
    run('add', '.');
    run('commit', '-q', '-m', 'Initial');
  }
  return { dir, run, write };
}

test('status keeps dots in branch and upstream names and parses divergence', () => {
  const s = parseStatus('## release/1.2...origin/release/1.2 [ahead 3, behind 4]\0');
  assert.equal(s.branch, 'release/1.2');
  assert.equal(s.upstream, 'origin/release/1.2');
  assert.equal(s.ahead, 3);
  assert.equal(s.behind, 4);
  assert.equal(parseStatus('## No commits yet on release/1.2\0').branch, 'release/1.2');
  assert.equal(parseStatus('## HEAD (no branch)\0').branch, null);
});

test('selected commit excludes and preserves unrelated staged changes', async (t) => {
  const { dir, run, write } = repository(t);
  write('other.txt', 'unselected staged content\n');
  run('add', 'other.txt');
  write('selected.txt', 'selected content\n');
  await commit(dir, 'Only the selection', ['selected.txt']);
  assert.equal(run('show', 'HEAD:other.txt'), 'original other');
  assert.equal(run('show', 'HEAD:selected.txt'), 'selected content');
  assert.equal(run('diff', '--cached', '--name-only'), 'other.txt');
});

test('empty or stale selections fail without staging anything', async (t) => {
  const { dir, run, write } = repository(t);
  write('selected.txt', 'modified\n');
  const head = run('rev-parse', 'HEAD');
  await assert.rejects(commit(dir, 'No selection', []), /Select at least one file/);
  await assert.rejects(commit(dir, 'Stale selection', ['missing.txt']), /changed|Refresh/);
  await assert.rejects(commit(dir, 'Mixed stale selection', ['selected.txt', 'missing.txt']), /changed|Refresh/);
  assert.equal(run('rev-parse', 'HEAD'), head);
  assert.equal(run('diff', '--cached', '--name-only'), '');
});

test('selected rename commits both paths and preserves other staged files', async (t) => {
  const { dir, run, write } = repository(t);
  run('mv', 'selected.txt', 'renamed.txt');
  write('other.txt', 'not selected\n');
  run('add', 'other.txt');
  await commit(dir, 'Rename selected file', ['renamed.txt']);
  assert.equal(run('ls-tree', '--name-only', 'HEAD'), 'other.txt\nrenamed.txt');
  assert.equal(run('show', 'HEAD:other.txt'), 'original other');
  assert.equal(run('diff', '--cached', '--name-only'), 'other.txt');
});

test('selected first commit supports untracked files and leaves other staged files', async (t) => {
  const { dir, run, write } = repository(t, false);
  write('selected.txt', 'first\n');
  write('other.txt', 'later\n');
  run('add', 'other.txt');
  await commit(dir, 'First selected file', ['selected.txt']);
  assert.equal(run('ls-tree', '--name-only', 'HEAD'), 'selected.txt');
  assert.equal(run('diff', '--cached', '--name-only'), 'other.txt');
});

test('selected deletion removes the file without committing other staged work', async (t) => {
  const { dir, run, write } = repository(t);
  fs.unlinkSync(path.join(dir, 'selected.txt'));
  write('other.txt', 'keep staged\n');
  run('add', 'other.txt');
  await commit(dir, 'Delete selected file', ['selected.txt']);
  assert.equal(run('ls-tree', '--name-only', 'HEAD'), 'other.txt');
  assert.equal(run('show', 'HEAD:other.txt'), 'original other');
  assert.equal(run('diff', '--cached', '--name-only'), 'other.txt');
});

test('selected files commit their working tree content, including changes after staging', async (t) => {
  const { dir, run, write } = repository(t);
  write('selected.txt', 'staged earlier\n');
  run('add', 'selected.txt');
  write('selected.txt', 'latest selected content\n');
  await commit(dir, 'Current selected content', ['selected.txt', 'selected.txt']);
  assert.equal(run('show', 'HEAD:selected.txt'), 'latest selected content');
  assert.deepEqual((await status(dir)).files, []);
});

test('paths containing wildcard syntax are treated literally in commit and diff', async (t) => {
  const { dir, run, write } = repository(t);
  write('[ab].txt', 'bracket file\n');
  write('a.txt', 'separate file\n');
  run('add', '.');
  run('commit', '-q', '-m', 'Add bracket paths');
  write('[ab].txt', 'selected bracket content\n');
  write('a.txt', 'must not include this content\n');
  const patch = await diff(dir, '[ab].txt', false);
  assert.match(patch, /selected bracket content/);
  assert.doesNotMatch(patch, /must not include this content/);
  await commit(dir, 'Literal path', ['[ab].txt']);
  assert.equal(run('show', 'HEAD:[ab].txt'), 'selected bracket content');
  assert.equal(run('show', 'HEAD:a.txt'), 'separate file');
  assert.deepEqual((await status(dir)).files.map((f) => f.path), ['a.txt']);
});

test('unknown remote actions are rejected as validation errors', () => {
  for (const action of ['toString', 'constructor', '__proto__', 'delete']) {
    assert.throws(() => remote('.', action), /Unknown action/);
  }
});

test('blank commit messages are rejected without staging the selection', async (t) => {
  const { dir, run, write } = repository(t);
  write('selected.txt', 'not staged\n');
  await assert.rejects(commit(dir, ' \n ', ['selected.txt']), /commit message/);
  assert.equal(run('diff', '--cached', '--name-only'), '');
});

test('missing Git on PATH fails without falling back to a project executable', (t) => {
  const { dir } = repository(t);
  // A fresh process resolves GIT with its own PATH at module load time.
  const script = `
    import assert from 'node:assert/strict';
    import { status } from ${JSON.stringify(new URL('../git.ts', import.meta.url).href)};
    await assert.rejects(status(process.cwd()), /Git executable not found on PATH/);
  `;
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
    cwd: dir, windowsHide: true, env: { ...process.env, PATH: '' },
  });
});
