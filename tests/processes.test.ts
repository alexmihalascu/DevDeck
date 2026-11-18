import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import pty from '@lydell/node-pty';
import { config } from '../core.ts';
import { handle, handlers, openWt, startService, terms } from '../processes.ts';
import type { ClientMsg, Service } from '../types.ts';

test('malformed and inherited WebSocket commands cannot reach handlers or crash the server', async () => {
  for (const msg of [
    { t: '__defineGetter__' }, { t: 'constructor' },
    { t: 'input', id: '1', data: { bad: true } },
    { t: 'resize', id: '1', cols: 2.5, rows: 30 },
    { t: 'resize', id: '1', cols: 1000000, rows: 30 },
    { t: 'killPid', pid: -1 }, { t: 'spawn', appId: 5 },
  ]) {
    const errors: string[] = [];
    await handle(msg as ClientMsg, (error) => errors.push(error));
    assert.equal(errors.length, 1, JSON.stringify(msg));
  }
});

test('both synchronous and asynchronous terminal failures return an error', async (t) => {
  const errors: string[] = [];
  t.mock.method(handlers, 'startService', () => { throw new Error('sync spawn failure'); });
  t.mock.method(handlers, 'restartService', async () => { throw new Error('async restart failure'); });
  await handle({ t: 'startService', serviceId: 'service' }, (e) => errors.push(e));
  await handle({ t: 'restartService', serviceId: 'service' }, (e) => errors.push(e));
  assert.deepEqual(errors, ['sync spawn failure', 'async restart failure']);
});

test('service restart uses edited configuration and close cancels a pending restart', async (t) => {
  const original = config.services;
  config.services = [];
  const calls: string[][] = [];
  const exits: ((event: { exitCode: number }) => void)[] = [];
  t.mock.method(childProcess, 'execFile', (_file: string, _args: string[], ...rest: unknown[]) => {
    const cb = rest.at(-1);
    if (typeof cb === 'function') cb(null, '', '');
    return {};
  });
  syncBuiltinESMExports();
  t.mock.method(pty, 'spawn', (_file: string, args: string[]) => {
    calls.push(args);
    return {
      pid: 999999, onData: () => {}, onExit: (cb: (event: { exitCode: number }) => void) => exits.push(cb),
      write: () => {}, resize: () => {},
    };
  });
  t.after(() => {
    for (const rec of terms.values()) clearTimeout(rec.forceKill);
    terms.clear(); config.services = original;
    t.mock.restoreAll(); syncBuiltinESMExports();
  });
  const svc: Service = { id: 'fixture', name: 'Fixture', cmd: 'old-command', stopCmd: '', cwd: '', port: null, logs: [], url: '', autostart: false };
  config.services.push(svc);
  startService(svc.id);
  svc.cmd = 'new-command';
  await handle({ t: 'restartService', serviceId: svc.id });
  assert.equal(calls.length, 1, 'wait for the old process to exit');
  exits[0]({ exitCode: 0 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].at(-1), 'new-command');
  const id = [...terms.keys()][0];
  await handle({ t: 'restartService', serviceId: svc.id });
  await handle({ t: 'close', id });
  exits[1]({ exitCode: 0 });
  assert.equal(calls.length, 2, 'close must not spawn an orphan replacement');
  assert.equal(terms.size, 0);
});

test('Windows Terminal args escape ";" in names and paths so a project cannot add wt subcommands', (t) => {
  const original = config.projects;
  let args: string[] = [];
  t.mock.method(childProcess, 'execFile', (_file: string, a: string[]) => { args = a; return {}; });
  syncBuiltinESMExports();
  t.after(() => { config.projects = original; t.mock.restoreAll(); syncBuiltinESMExports(); });
  config.projects = [{ id: 'p', name: 'P', apps: [{ id: 'a', name: 'x;new-tab evil', path: 'C:\\w;y', pm: 'npm', autostart: 'dev' }] } as never];
  assert.equal(openWt('p'), true);
  assert.ok(args.every((x, i) => x === ';' || i === 0 || !/(^|[^\\]);/.test(x)), args.join(' | '));
});
