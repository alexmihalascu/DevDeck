import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createDb, parseBackup } from '../db.ts';

function fixture(t: TestContext, run: (name: string, args: string[], cb: (error: Error | null, out: string, stderr: string) => void) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-db-test-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['mysql', 'mysqldump']) fs.writeFileSync(path.join(bin, `${name}.exe`), '');
  t.mock.method(childProcess, 'execFile', (file: string, args: string[], _options: unknown, cb: (error: Error | null, out: string, stderr: string) => void) => {
    run(path.basename(file, '.exe'), args, cb);
    return {};
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(path.dirname(dir), os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db: createDb({ dir: path.join(dir, 'backups'), bin: () => bin, creds: () => ({}) }) };
}

test('same-second backups get independent complete files and remain parseable', async (t) => {
  let dump = 0;
  const { db } = fixture(t, (name, args, cb) => {
    if (name === 'mysql') return cb(null, 'app\t0\t0\n', '');
    const file = args.find((arg) => arg.startsWith('--result-file='))!.slice('--result-file='.length);
    assert.match(file, /\.partial$/);
    fs.writeFileSync(file, `dump ${++dump}`);
    cb(null, '', '');
  });
  const [first, second] = await Promise.all([db.backup('app'), db.backup('app')]);
  assert.notEqual(first.file, second.file);
  assert.equal(parseBackup(first.file)?.name, 'app');
  assert.equal(parseBackup(second.file)?.kind, 'manual');
  assert.equal(fs.readFileSync(path.join(db.DIR, first.file), 'utf8'), 'dump 1');
  assert.equal(fs.readFileSync(path.join(db.DIR, second.file), 'utf8'), 'dump 2');
  assert.equal((await db.list()).backups.length, 2);
  assert.ok(fs.readdirSync(db.DIR).every((file) => file.endsWith('.sql')));
});

test('failed dumps never become restore candidates and clean up their partial file', async (t) => {
  const { db } = fixture(t, (name, args, cb) => {
    if (name === 'mysql') return cb(null, 'app\t0\t0\n', '');
    const file = args.find((arg) => arg.startsWith('--result-file='))!.slice('--result-file='.length);
    fs.writeFileSync(file, 'incomplete SQL');
    cb(new Error('dump failed'), '', 'dump failed');
  });
  await assert.rejects(db.backup('app'), /dump failed/);
  assert.deepEqual(fs.readdirSync(db.DIR), []);
  assert.deepEqual((await db.list()).backups, []);
});

test('restore reports stdin write failures without an uncaught stream error', async (t) => {
  const { db } = fixture(t, (_name, _args, cb) => cb(null, '', ''));
  const filename = 'app-20261108-120000.sql';
  fs.mkdirSync(db.DIR);
  fs.writeFileSync(path.join(db.DIR, filename), 'SELECT 1;');
  let killed = false;
  t.mock.method(childProcess, 'spawn', () => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(_data, _encoding, cb) { cb(new Error('simulated EPIPE')); } }),
      stderr: new PassThrough(),
      kill() { killed = true; proc.emit('close', null); },
    });
    return proc;
  });
  syncBuiltinESMExports();
  await assert.rejects(db.restore(filename), /simulated EPIPE/);
  assert.equal(killed, true);
});

test('restore reports a file disappearing before streaming and stops its child', async (t) => {
  let full = '';
  const { db } = fixture(t, (_name, _args, cb) => { fs.unlinkSync(full); cb(null, '', ''); });
  const filename = 'app-20261108-120000.sql';
  fs.mkdirSync(db.DIR);
  full = path.join(db.DIR, filename);
  fs.writeFileSync(full, 'SELECT 1;');
  let killed = false;
  t.mock.method(childProcess, 'spawn', () => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stderr: new PassThrough(),
      kill() { killed = true; proc.emit('close', null); },
    });
    return proc;
  });
  syncBuiltinESMExports();
  await assert.rejects(db.restore(filename), /ENOENT/);
  assert.equal(killed, true);
});

test('backup rotation handles prototype-like database names and leaves manual copies', async (t) => {
  const { db } = fixture(t, (_name, _args, cb) => cb(null, '', ''));
  fs.mkdirSync(db.DIR);
  const names = ['__proto__-20261108-120000-auto.sql', '__proto__-20261108-120001-auto.sql', '__proto__-20261108-120002.sql'];
  names.forEach((name, index) => {
    const file = path.join(db.DIR, name);
    fs.writeFileSync(file, 'sql'); fs.utimesSync(file, 1000 + index, 1000 + index);
  });
  db.prune(1);
  assert.deepEqual(fs.readdirSync(db.DIR).sort(), names.slice(1));
  assert.throws(() => db.prune(0), /positive integer/);
});
