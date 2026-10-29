// "Does this project have what it needs?" A checklist per project, each failed item with a fix where one exists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project, Requirement, Service } from './types.ts';

/**
 * Does the running Node satisfy an engines/.nvmrc spec? Major-version reasoning only
 * (">=18", "^20", "20.x", "~22.1", "18 || 20", "v20.11.0"); anything fancier answers null = can't tell.
 */
export function nodeSatisfies(spec: string, version = process.versions.node): boolean | null {
  const major = Number(version.split('.')[0]);
  const parts = spec.split('||').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  let known = false;
  for (const part of parts) {
    const conds = part.split(/\s+/).filter(Boolean);
    let ok = true, understood = true;
    for (const c of conds) {
      const m = c.match(/^(>=|>|<=|<|\^|~|=|v)?(\d+)(?:\.(?:\d+|x|\*))*$/i);
      if (!m) { understood = false; break; }
      const n = Number(m[2]);
      const op = m[1] || '';
      if (op === '>=') ok &&= major >= n;
      else if (op === '>') ok &&= major > n || (major === n && version !== `${n}.0.0`);
      else if (op === '<=') ok &&= major <= n;
      else if (op === '<') ok &&= major < n;
      else ok &&= major === n; // ^20, ~20, 20.x, 20, v20.11
    }
    if (!understood) continue;
    known = true;
    if (ok) return true;
  }
  return known ? false : null;
}

const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readText = (f: string) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
export const envKeys = (text: string) => new Set([...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/gm)].map((m) => m[1]));
const EXAMPLE_RE = /^\.env\.(example|sample|template|dist)$/i;

interface Context { listening: Record<string, number>; databases: string[] | null; services: Service[]; needed: { id: string; auto: boolean }[] }

export function checkProject(p: Project, ctx: Context): Requirement[] {
  const out: Requirement[] = [];
  const dirs = [...new Set([p.path, ...p.apps.map((a) => a.path)])];
  const rel = (f: string) => path.relative(p.path, f).replaceAll('\\', '/') || '.';

  // Node version from engines.node / .nvmrc / .node-version
  for (const dir of dirs) {
    const spec = readJson(path.join(dir, 'package.json'))?.engines?.node || readText(path.join(dir, '.nvmrc')) || readText(path.join(dir, '.node-version'));
    if (!spec || /^(lts|node|stable)/i.test(spec)) continue;
    const ok = nodeSatisfies(String(spec));
    out.push({
      id: `node:${dir}`, label: `Node ${spec}${dirs.length > 1 ? ` (${rel(dir)})` : ''}`,
      status: ok === null ? 'unknown' : ok ? 'ok' : 'fail',
      detail: ok === null ? `Installed: ${process.version}. Can't tell from this range.` : `Installed: ${process.version}`,
    });
  }

  // Dependencies installed
  for (const a of p.apps.filter((x) => x.install)) {
    out.push({
      id: `deps:${a.id}`, label: `${a.name}: dependencies`,
      status: a.install === 'ok' ? 'ok' : 'fail',
      detail: a.install === 'ok' ? 'node_modules matches package.json' : a.install === 'missing' ? 'node_modules is missing' : 'Some packages from package.json are not installed',
      fix: a.install === 'ok' ? undefined : { kind: 'install', arg: a.id, label: `${a.pm} install` },
    });
  }

  // Services this project needs (ticked in Overview, or MySQL detected from its database settings)
  for (const { id, auto } of ctx.needed) {
    const s = ctx.services.find((x) => x.id === id);
    if (!s) continue;
    const up = !s.port || !!ctx.listening[s.port];
    out.push({
      id: `svc:${id}`, label: `${s.name} running`, status: up ? 'ok' : 'fail',
      detail: `${s.port ? (up ? `Listening on :${s.port}` : `Nothing on :${s.port}, starts with your scripts`) : 'No port to check'}${auto ? ' (needed: the project uses a database)' : ''}`,
      fix: up ? undefined : { kind: 'service', arg: id, label: `Start ${s.name}` },
    });
  }

  // .env next to every .env.example has all its keys
  for (const dir of dirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const ex of files.filter((f) => EXAMPLE_RE.test(f))) {
      const env = path.join(dir, '.env');
      const want = envKeys(fs.readFileSync(path.join(dir, ex), 'utf8'));
      if (!fs.existsSync(env)) {
        out.push({
          id: `env:${dir}`, label: `${rel(path.join(dir, '.env'))}`, status: 'fail',
          detail: `Missing. ${ex} lists ${want.size} variable${want.size === 1 ? '' : 's'}.`,
          fix: { kind: 'env', arg: path.join(dir, ex), label: `Create from ${ex}` },
        });
        continue;
      }
      const have = envKeys(fs.readFileSync(env, 'utf8'));
      const missing = [...want].filter((k) => !have.has(k));
      out.push({
        id: `env:${dir}`, label: `${rel(env)} complete`, status: missing.length ? 'warn' : 'ok',
        detail: missing.length ? `Missing from ${ex}: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` +${missing.length - 6}` : ''}` : `Has every key from ${ex}`,
        fix: missing.length ? { kind: 'env', arg: path.join(dir, ex), label: 'Add missing keys' } : undefined,
      });
    }
  }

  // The database the .env points at
  if (p.db) {
    const exists = ctx.databases?.includes(p.db);
    out.push({
      id: 'db', label: `Database ${p.db}`,
      status: ctx.databases === null ? 'unknown' : exists ? 'ok' : 'fail',
      detail: ctx.databases === null ? 'MySQL is not running, start it to check' : exists ? 'Exists in MySQL' : 'Not found in MySQL',
      fix: ctx.databases !== null && !exists ? { kind: 'db', arg: p.db, label: 'Create database' } : undefined,
    });
  }
  return out;
}

/** Create .env from the example, or append the keys it lacks (empty values, marked). Never overwrites a value. */
export function fillEnv(example: string): string {
  const dir = path.dirname(example);
  const env = path.join(dir, '.env');
  const exText = fs.readFileSync(example, 'utf8');
  if (!fs.existsSync(env)) { fs.writeFileSync(env, exText); return `Created .env from ${path.basename(example)}`; }
  const have = envKeys(fs.readFileSync(env, 'utf8'));
  const lines = exText.split(/\r?\n/).filter((l) => { const k = l.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/)?.[1]; return k && !have.has(k); });
  if (!lines.length) return 'Nothing to add';
  fs.appendFileSync(env, `${os.EOL}# Added by Devdeck from ${path.basename(example)}${os.EOL}${lines.join(os.EOL)}${os.EOL}`);
  return `Added ${lines.length} key${lines.length === 1 ? '' : 's'} to .env`;
}

if (process.argv[1]?.endsWith('requirements.ts') && process.argv.includes('--test')) {
  assert.equal(nodeSatisfies('>=18', '24.14.0'), true);
  assert.equal(nodeSatisfies('^20', '24.14.0'), false);
  assert.equal(nodeSatisfies('20.x || 24.x', '24.14.0'), true);
  assert.equal(nodeSatisfies('v24.11.0', '24.14.0'), true);
  assert.equal(nodeSatisfies('>=18 <22', '24.14.0'), false);
  assert.equal(nodeSatisfies('lts/*', '24.14.0'), null);
  assert.deepEqual([...envKeys('A=1\n# B=2\nexport C="x"\n  D =\n')], ['A', 'C', 'D']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-req-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=99' } }));
  fs.writeFileSync(path.join(dir, '.env.example'), 'DB_HOST=localhost\nDB_DATABASE=app\nSECRET=\n');
  fs.writeFileSync(path.join(dir, '.env'), 'DB_HOST=127.0.0.1\n');
  const project: Project = {
    id: dir, name: 'x', path: dir, branch: null, icon: null, envFiles: [], db: 'app', services: ['mysql'],
    apps: [{ id: dir, name: 'x', path: dir, pm: 'npm', scripts: [], cmds: {}, stack: [], version: null, install: 'missing', autostart: null }],
  };
  const svc: Service = { id: 'mysql', name: 'MySQL', cmd: 'x', stopCmd: '', cwd: '', port: 3306, url: '', logs: [], autostart: false };
  const byId = (r: Requirement[]) => Object.fromEntries(r.map((x) => [x.id.split(':')[0], x]));
  const needed = [{ id: 'mysql', auto: false }];
  let r = byId(checkProject(project, { listening: {}, databases: null, services: [svc], needed }));
  assert.equal(r.node.status, 'fail');
  assert.equal(r.deps.fix?.kind, 'install');
  assert.equal(r.svc.status, 'fail');
  assert.equal(r.env.status, 'warn');
  assert.match(r.env.detail, /DB_DATABASE, SECRET/);
  assert.equal(r.db.status, 'unknown');
  assert.equal(fillEnv(path.join(dir, '.env.example')), 'Added 2 keys to .env');
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /^DB_HOST=127\.0\.0\.1/, 'existing value untouched');
  r = byId(checkProject(project, { listening: { 3306: 1 }, databases: ['other'], services: [svc], needed }));
  assert.equal(r.env.status, 'ok');
  assert.equal(r.svc.status, 'ok');
  assert.equal(r.db.fix?.kind, 'db');
  fs.rmSync(dir, { recursive: true });
  console.log('requirements.ts: all checks passed');
}
