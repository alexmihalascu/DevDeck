import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { BackupFile, DbInfo } from './types.ts';

const SYSTEM = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', 'phpmyadmin', 'test']);
const NAME_RE = /^[\w$-]{1,64}$/;
const FILE_RE = /^(.+)-(\d{8}-\d{6})(-pre-restore|-auto|-pre-pull)?\.sql$/;
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });

// Local time, so file names match the clock on the wall: 20261029-200604
const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
export const parseBackup = (file: string) => {
  const m = path.basename(file).match(FILE_RE);
  return m && { name: m[1], stamp: m[2], preRestore: m[3] === '-pre-restore', kind: m[3]?.slice(1) || 'manual' };
};

interface DbOptions { dir: string; bin: () => string | null; creds: () => { user?: string; password?: string } }

// MySQL/MariaDB backups through XAMPP's own mysqldump/mysql binaries. Password goes via MYSQL_PWD, never argv.
export function createDb({ dir, bin, creds }: DbOptions) {
  const exe = (name: string) => {
    const b = bin();
    const f = b && path.join(b, `${name}.exe`);
    if (!f || !fs.existsSync(f)) throw fail('MySQL tools not found. Is XAMPP installed?', 404);
    return f;
  };
  const env = () => ({ ...process.env, MYSQL_PWD: creds().password || '' });
  const user = () => creds().user || 'root';
  const run = (name: string, args: string[]) => new Promise<string>((resolve, reject) => {
    execFile(exe(name), ['-u', user(), ...args], { env: env(), windowsHide: true, maxBuffer: 32 << 20 }, (err, out, errOut) => {
      if (err) return reject(fail(/Can't connect|2002|2003/.test(errOut) ? 'MySQL is not running. Start it in Services first.' : (errOut || err.message).trim()));
      resolve(out);
    });
  });

  function backups(): BackupFile[] {
    fs.mkdirSync(dir, { recursive: true });
    return fs.readdirSync(dir).flatMap((f) => {
      const info = parseBackup(f);
      if (!info) return [];
      const st = fs.statSync(path.join(dir, f));
      return [{ file: f, ...info, size: st.size, at: st.mtimeMs }];
    }).sort((a, b) => b.at - a.at);
  }

  async function databases(): Promise<DbInfo[]> {
    const out = await run('mysql', ['-N', '-B', '-e',
      'SELECT s.schema_name, COALESCE(SUM(t.data_length + t.index_length), 0), COUNT(t.table_name) FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name GROUP BY s.schema_name']);
    return out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
      const [name, size, tables] = l.split('\t');
      return { name, size: Number(size), tables: Number(tables), system: SYSTEM.has(name.toLowerCase()) };
    });
  }

  async function backup(name: string, suffix = '') {
    if (!NAME_RE.test(name || '')) throw fail('Bad database name');
    if (!(await databases()).some((d) => d.name === name)) throw fail(`Database "${name}" does not exist`, 404);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}-${stamp()}${suffix}.sql`);
    await run('mysqldump', ['--single-transaction', '--routines', '--triggers', '--events', '--databases', name, `--result-file=${file}`]);
    return { file: path.basename(file), size: fs.statSync(file).size };
  }

  async function restore(file: string) {
    const info = parseBackup(file || '');
    const full = path.join(dir, path.basename(file || ''));
    if (!info || !fs.existsSync(full)) throw fail('Unknown backup file', 404);
    // Safety net: snapshot the current state before overwriting it.
    let safety: string | null = null;
    if ((await databases()).some((d) => d.name === info.name)) safety = (await backup(info.name, '-pre-restore')).file;
    await new Promise<void>((resolve, reject) => {
      const p = spawn(exe('mysql'), ['-u', user()], { env: env(), windowsHide: true });
      let errOut = '';
      p.stderr.on('data', (d: Buffer) => { errOut += d; });
      p.on('error', reject);
      p.on('close', (code) => code ? reject(fail(errOut.trim() || `mysql exited with ${code}`)) : resolve());
      fs.createReadStream(full).pipe(p.stdin);
    });
    return { ok: true, safety };
  }

  return {
    DIR: dir,
    list: async () => {
      let dbs: DbInfo[] | null = null, error: string | null = null;
      try { dbs = await databases(); } catch (e) { error = (e as Error).message; }
      return { databases: dbs, backups: backups(), error };
    },
    backup,
    databases,
    async create(name: string) {
      if (!NAME_RE.test(name || '')) throw fail('Bad database name');
      await run('mysql', ['-e', `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`]);
      return { ok: true };
    },
    // Scheduled backups rotate: keep the newest `keep` automatic copies per database, never touch manual ones.
    prune(keep: number) {
      const byDb: Record<string, BackupFile[]> = {};
      for (const b of backups().filter((x) => x.kind === 'auto')) (byDb[b.name] ??= []).push(b);
      for (const list of Object.values(byDb)) for (const b of list.slice(keep)) fs.unlinkSync(path.join(dir, b.file));
    },
    restore,
    remove: (file: string) => {
      const full = path.join(dir, path.basename(file || ''));
      if (!parseBackup(file || '') || !fs.existsSync(full)) throw fail('Unknown backup file', 404);
      fs.unlinkSync(full);
      return { ok: true };
    },
  };
}
export type Db = ReturnType<typeof createDb>;

if (process.argv[1]?.endsWith('db.ts') && process.argv.includes('--test')) {
  assert.deepEqual(parseBackup('shop_db-20261029-195901.sql'), { name: 'shop_db', stamp: '20261029-195901', preRestore: false, kind: 'manual' });
  assert.deepEqual(parseBackup('my-app-20261029-195901-pre-restore.sql'), { name: 'my-app', stamp: '20261029-195901', preRestore: true, kind: 'pre-restore' });
  assert.equal(parseBackup('x-20261029-195901-auto.sql')?.kind, 'auto');
  // prune keeps the newest N automatic copies and leaves manual ones alone
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-bk-'));
  const files = ['a-20260101-000001-auto.sql', 'a-20260101-000002-auto.sql', 'a-20260101-000003-auto.sql', 'a-20260101-000004.sql'];
  files.forEach((f, i) => { fs.writeFileSync(path.join(tmp, f), ''); fs.utimesSync(path.join(tmp, f), 1000 + i, 1000 + i); });
  createDb({ dir: tmp, bin: () => null, creds: () => ({}) }).prune(2);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['a-20260101-000002-auto.sql', 'a-20260101-000003-auto.sql', 'a-20260101-000004.sql']);
  fs.rmSync(tmp, { recursive: true });
  assert.equal(parseBackup('../../etc/passwd'), null);
  assert.equal(stamp(new Date(2026, 9, 29, 19, 59, 1)), '20261029-195901');
  const db = createDb({ dir: '.', bin: () => null, creds: () => ({}) });
  await assert.rejects(db.backup('x; DROP'), /Bad database name/);
  await assert.rejects(db.backup('ok'), /MySQL tools not found/);
  console.log('db.ts: all checks passed');
}
