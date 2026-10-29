import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitCommit, GitFile, GitStatus } from './types.ts';

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });

// Windows looks in the child's cwd before PATH, so a git.exe inside a project folder would win.
// Resolve the real binary from PATH once instead.
export const findExe = (name: string): string | null => (process.env.PATH || '').split(path.delimiter)
  .map((d) => path.join(d.replace(/"/g, ''), process.platform === 'win32' ? `${name}.exe` : name))
  .find((f) => path.isAbsolute(f) && fs.existsSync(f)) || null;
const GIT = findExe('git') || 'git';

// Every git call goes through execFile (no shell), so paths and messages are never parsed as commands.
const git = (cwd: string, args: string[], { allowFail = false } = {}) => new Promise<string>((resolve, reject) => {
  execFile(GIT, ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
    { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, stdout, stderr) => {
      if (err && !allowFail) return reject(fail((stderr || err.message).trim()));
      resolve(stdout);
    });
});

export const isRepo = (dir: string) => fs.existsSync(path.join(dir, '.git'));

// "## main...origin/main [ahead 1, behind 2]" + "XY path" entries (-z: NUL separated, renames carry the old path next)
export function parseStatus(out: string): GitStatus {
  const parts = out.split('\0');
  const head = parts[0].startsWith('## ') ? (parts.shift() as string).slice(3) : '';
  const m = head.match(/^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/) || [];
  const files: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const x = e[0], y = e[1];
    const f: GitFile = { path: e.slice(3), x, y, staged: x !== ' ' && x !== '?', untracked: x === '?' };
    if (x === 'R' || x === 'C') f.from = parts[++i];
    files.push(f);
  }
  return {
    branch: m[1] || null, upstream: m[2] || null,
    ahead: Number(m[3]?.match(/ahead (\d+)/)?.[1] || 0),
    behind: Number(m[3]?.match(/behind (\d+)/)?.[1] || 0),
    files,
  };
}

export const status = async (dir: string) => parseStatus(await git(dir, ['status', '--porcelain=v1', '-b', '-z', '-uall']));

const SEP = '\x1f', END = '\x1e';
export async function log(dir: string, n = 60): Promise<GitCommit[]> {
  const out = await git(dir, ['log', `-n${n}`, `--pretty=format:%H${SEP}%h${SEP}%an${SEP}%at${SEP}%D${SEP}%s${END}`], { allowFail: true });
  return out.split(END).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [hash, short, author, at, refs, subject] = l.split(SEP);
    return { hash, short, author, at: Number(at) * 1000, refs, subject };
  });
}

export async function diff(dir: string, file: string, untracked: boolean): Promise<string> {
  if (untracked) {
    // Exit code 1 means "files differ", which is the expected result here.
    return git(dir, ['diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file], { allowFail: true });
  }
  const out = await git(dir, ['diff', 'HEAD', '--', file], { allowFail: true });
  return out || git(dir, ['diff', '--cached', '--', file], { allowFail: true });
}

export const show = (dir: string, hash: string) => {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw fail('Bad commit hash');
  return git(dir, ['show', '--stat', '--patch', '--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B', hash]);
};

export async function commit(dir: string, message: string, files: string[]) {
  if (!String(message || '').trim()) throw fail('Write a commit message first.');
  await git(dir, files.length ? ['add', '-A', '--', ...files] : ['add', '-A']);
  return git(dir, ['commit', '-m', message]);
}

const REMOTE = { fetch: ['fetch', '--prune'], pull: ['pull', '--ff-only'], push: ['push'] } as const;
export const remote = (dir: string, action: string) => {
  if (!(action in REMOTE)) throw fail('Unknown action');
  return git(dir, [...REMOTE[action as keyof typeof REMOTE]]).then((out) => out || `${action}: done`);
};

if (process.argv[1]?.endsWith('git.ts') && process.argv.includes('--test')) {
  const s = parseStatus('## main...origin/main [ahead 2, behind 1]\0 M src/a b.ts\0R  new.ts\0old.ts\0?? notes.md\0');
  assert.equal(s.branch, 'main');
  assert.equal(s.upstream, 'origin/main');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.deepEqual(s.files.map((f) => f.path), ['src/a b.ts', 'new.ts', 'notes.md']);
  assert.equal(s.files[1].from, 'old.ts');
  assert.equal(s.files[2].untracked, true);
  assert.equal(s.files[0].staged, false);
  const fresh = parseStatus('## No commits yet on main\0?? a.txt\0');
  assert.equal(fresh.branch, 'main');
  assert.equal(fresh.ahead, 0);
  console.log('git.ts: all checks passed');
}
