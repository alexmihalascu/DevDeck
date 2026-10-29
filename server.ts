// HTTP + WebSocket: login gate, REST API, static files (browser TypeScript is type-stripped on the fly).
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { scanProject } from './scan.ts';
import * as git from './git.ts';
import { createDb } from './db.ts';
import { createAuth, isLoopback, lanAddresses, type Session } from './auth.ts';
import { checkProject, fillEnv } from './requirements.ts';
import {
  config, save, publicConfig, rescan, cleanService, detectXampp, broadcast, clients, fail, isDir,
  ROOT, DATA, PORT, HOST, POWERSHELL, CMD, EXPLORER, XAMPP, type HttpError,
} from './core.ts';
import {
  terms, meta, handle, startAll, neededServices, startService, killAll, checkHealth, listeningPids, openWt,
  health, stats, machine, statsHistory, docker, dockerLogs, refreshDocker,
} from './processes.ts';
import type { ClientMsg, GitSummary, Project } from './types.ts';

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { killAll(); process.exit(0); });

// ---------- request helpers ----------
type Body = Record<string, unknown>;
interface Ctx { local: boolean; session: Session | null }
type Route = (body: Body, ctx: Ctx) => unknown;

const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const readBody = (req: IncomingMessage) => new Promise<Body>((resolve, reject) => {
  let s = '';
  req.on('data', (c: Buffer) => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const redirect = (res: ServerResponse, to: string) => { res.writeHead(302, { location: to }); res.end(); };

// Host must be a name of this PC: blocks DNS rebinding. LAN IPs are re-read so DHCP changes just work.
const hostOk = (host = '') => {
  const i = host.lastIndexOf(':');
  if (i < 0 || host.slice(i + 1) !== String(PORT)) return false;
  const name = host.slice(0, i).toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === os.hostname().toLowerCase() || lanAddresses().includes(name);
};
const sameOrigin = (req: IncomingMessage) => req.headers.origin === `http://${req.headers.host}`;

// ---------- static files ----------
const STATIC: Record<string, string> = {
  '/vendor/xterm/': 'node_modules/@xterm/xterm/',
  '/vendor/addon-fit/': 'node_modules/@xterm/addon-fit/',
  '/vendor/phosphor/': 'node_modules/@phosphor-icons/web/src/',
  '/vendor/geist-mono/': 'node_modules/@fontsource-variable/geist-mono/',
  '/vendor/geist/': 'node_modules/@fontsource-variable/geist/',
  '/': 'public/',
};
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.ts': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml',
};
// Browser modules are written in TypeScript; strip the types on request (cached until the file changes).
const tsCache = new Map<string, { mtime: number; js: string }>();
function serveStatic(res: ServerResponse, pathname: string) {
  if (pathname === '/') pathname = '/index.html';
  const prefix = Object.keys(STATIC).find((k) => pathname.startsWith(k)) as string;
  const base = path.join(ROOT, STATIC[prefix]);
  const file = path.join(base, decodeURIComponent(pathname.slice(prefix.length)));
  if (!file.startsWith(base)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(file);
    let body: Buffer | string = data;
    if (ext === '.ts') {
      const mtime = fs.statSync(file).mtimeMs;
      const hit = tsCache.get(file);
      if (hit?.mtime === mtime) body = hit.js;
      else {
        try { body = stripTypeScriptTypes(data.toString('utf8')); } catch (e) { return send(res, 500, `${file}: ${(e as Error).message}`); }
        tsCache.set(file, { mtime, js: body });
      }
    }
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  });
}

function serveIcon(res: ServerResponse, id: string | null) {
  const icon = config.projects.find((p) => p.id === id)?.icon;
  if (!icon) return send(res, 404, 'no icon');
  fs.readFile(icon, (err, data) => {
    if (err) return send(res, 404, 'no icon');
    // Icons come from other projects' folders; an SVG must never run script on this origin.
    res.writeHead(200, {
      'content-type': ({ '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' } as Record<string, string>)[path.extname(icon).toLowerCase()] || 'application/octet-stream',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'max-age=300',
    });
    res.end(data);
  });
}

// ---------- host-PC helpers ----------
// Modern Explorer-style picker: an OpenFileDialog that accepts a folder instead of a file.
const PICK_PS = `Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$d = New-Object System.Windows.Forms.OpenFileDialog -Property @{ ValidateNames = $false; CheckFileExists = $false; CheckPathExists = $true; FileName = 'Select this folder'; Title = 'Choose a project folder' }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Split-Path $d.FileName }`;
const pickFolder = () => new Promise<string | null>((resolve) => {
  execFile(POWERSHELL, ['-NoProfile', '-STA', '-Command', PICK_PS], { windowsHide: true }, (err, out) => resolve(err ? null : out.trim() || null));
});
const knownPath = (p: string) => config.projects.some((x) => x.path === p || x.apps.some((a) => a.path === p)) || config.services.some((x) => x.cwd === p);
// Only .env files the scan found inside a known project can be read or written.
const envFile = (file: string) => {
  if (!config.projects.some((p) => p.envFiles?.includes(file)) || !fs.existsSync(file)) throw fail('Not a known .env file', 403);
  return file;
};
function tail(file: string, bytes = 96_000) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return { text: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs, truncated: st.size > len };
  } finally { fs.closeSync(fd); }
}

// ---------- start with Windows (current user, no admin) ----------
const STARTUP_VBS = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Devdeck.vbs');
const LAUNCHER = path.join(DATA, 'launch.vbs');
// Starts Devdeck with no console window (a second copy exits on its own); the desktop one also opens the browser.
// Uses node's absolute path so a changed PATH doesn't break it.
function writeLauncher(file: string, openBrowser: boolean) {
  const q = (s: string) => s.replaceAll('"', '""');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${q(ROOT)}"`,
    `sh.Run """${q(process.execPath)}"" --disable-warning=ExperimentalWarning server.ts", 0, False`,
    ...(openBrowser ? ['WScript.Sleep 1500', `sh.Run "http://localhost:${PORT}"`] : []),
  ].join('\r\n'));
}
const loginAutostart = () => fs.existsSync(STARTUP_VBS);
function setLoginAutostart(on: boolean) {
  if (on) writeLauncher(STARTUP_VBS, false);
  else fs.rmSync(STARTUP_VBS, { force: true });
}
// An existing autostart entry from the .js days must point at server.ts now.
if (loginAutostart() && fs.readFileSync(STARTUP_VBS, 'utf8').includes('server.js')) setLoginAutostart(true);
function desktopShortcut() {
  writeLauncher(LAUNCHER, true);
  const ps = (s: string) => s.replaceAll("'", "''");
  return new Promise<string>((resolve, reject) => execFile(POWERSHELL, ['-NoProfile', '-Command', `
    $desk = [Environment]::GetFolderPath('Desktop')
    $l = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desk 'Devdeck.lnk'))
    $l.TargetPath = Join-Path $env:SystemRoot 'System32/wscript.exe'
    $l.Arguments = '"${ps(LAUNCHER)}"'
    $l.WorkingDirectory = '${ps(ROOT)}'
    $l.IconLocation = (Join-Path $env:SystemRoot 'System32/imageres.dll') + ',109'
    $l.Description = 'Start Devdeck and open it'
    $l.Save()
    Join-Path $desk 'Devdeck.lnk'`], { windowsHide: true }, (e, so, se) => e ? reject(new Error(se || e.message)) : resolve(so.trim())));
}

// ---------- databases ----------
const db = createDb({ dir: path.join(DATA, 'backups'), bin: () => XAMPP && path.join(XAMPP, 'mysql', 'bin'), creds: () => config.mysql });
async function backupTick() {
  const b = config.backup;
  if (!b?.enabled || Date.now() - (b.lastRun || 0) < b.everyHours * 3600_000) return;
  if (!(await listeningPids())[3306]) return; // MySQL off: try again next tick
  b.lastRun = Date.now();
  const result: string[] = b.lastResult = [];
  try {
    for (const d of (await db.databases()).filter((x) => !x.system)) {
      try { await db.backup(d.name, '-auto'); result.push(d.name); } catch (e) { result.push(`${d.name}: ${(e as Error).message}`); }
    }
    db.prune(b.keep);
  } catch (e) { result.push((e as Error).message); }
  save();
}
setInterval(backupTick, 60_000);

// ---------- git summary for every project (sidebar + dashboard badges) ----------
const repoOf = (projectId: unknown) => {
  const p = config.projects.find((x) => x.id === projectId);
  if (!p || !git.isRepo(p.path)) throw fail('Not a git repository');
  return p.path;
};
let gitSummary: Record<string, GitSummary> = {};
let gitBusy = false;
async function refreshGit() {
  if (gitBusy) return;
  gitBusy = true;
  try {
    const next: Record<string, GitSummary> = {};
    await Promise.all(config.projects.filter((p) => git.isRepo(p.path)).map(async (p) => {
      try {
        const s = await git.status(p.path);
        next[p.id] = { branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, changed: s.files.length };
      } catch {}
    }));
    if (JSON.stringify(next) !== JSON.stringify(gitSummary)) { gitSummary = next; broadcast({ t: 'git', git: gitSummary }); }
  } finally { gitBusy = false; }
}
setInterval(refreshGit, 8000);

// ---------- accounts ----------
fs.mkdirSync(DATA, { recursive: true });
const auth = createAuth({ file: path.join(DATA, 'devdeck.db') });
// On the host PC you manage every account; from another PC only your own.
const targetUser = (id: unknown, { local, session }: Ctx) => (local && id ? Number(id) : (session as Session).userId);

// ---------- API ----------
const api: Record<string, Route> = {
  'GET /api/config': () => config,
  'GET /api/stats/history': () => statsHistory(),
  'PUT /api/config': ({ projects, roots, manual }) => {
    // Only user choices are editable; structure always comes from disk.
    if (Array.isArray(roots)) config.roots = config.roots.filter((r) => roots.includes(r));
    if (Array.isArray(manual)) config.manual = config.manual.filter((r) => manual.includes(r));
    const byId = new Map((Array.isArray(projects) ? projects as Partial<Project>[] : []).map((p) => [p.id, p]));
    config.projects = config.projects.map((p) => {
      const n = byId.get(p.id);
      if (!n) return p;
      const apps = new Map(n.apps?.map((a) => [a.id, a]));
      return {
        ...p, name: String(n.name || p.name).slice(0, 80), hidden: !!n.hidden,
        services: Array.isArray(n.services) ? n.services.filter((id) => config.services.some((s) => s.id === id)) : p.services,
        bootStart: n.bootStart === undefined ? p.bootStart : !!n.bootStart,
        apps: p.apps.map((a) => {
          const s = apps.get(a.id)?.autostart;
          return s === null || (typeof s === 'string' && a.scripts.includes(s)) ? { ...a, autostart: s } : a;
        }),
      };
    });
    rescan();
    return config;
  },
  'POST /api/scan': () => { rescan(); return config; },
  'POST /api/folders': ({ path: raw, kind }) => {
    const dir = path.resolve(str(raw).trim().replace(/^"|"$/g, ''));
    if (!isDir(dir)) throw fail(`Folder not found: ${dir}`);
    if (kind === 'project') {
      if (!scanProject(dir).apps.length) throw fail('No package.json found in this folder or its subfolders.');
      if (!config.manual.includes(dir)) config.manual.push(dir);
    } else if (!config.roots.includes(dir)) config.roots.push(dir);
    rescan();
    return config;
  },
  'POST /api/pick-folder': async () => ({ path: await pickFolder() }),
  'POST /api/open': ({ path: p, with: app }) => {
    const target = str(p);
    if (!knownPath(target)) throw fail('Unknown path');
    if (app === 'code') execFile(CMD, ['/c', 'code', target], { windowsHide: true }, () => {});
    else spawn(EXPLORER, [target], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  },
  'POST /api/open-wt': ({ projectId }) => {
    if (!openWt(str(projectId))) throw fail('No starred scripts in this project. Star a script first.');
    return { ok: true };
  },

  // services
  'POST /api/services': (body) => {
    const svc = cleanService(body);
    if (!svc.cmd) throw fail('Command is required.');
    const i = config.services.findIndex((x) => x.id === svc.id);
    if (i >= 0) config.services[i] = svc; else config.services.push(svc);
    save(); checkHealth();
    return config;
  },
  'POST /api/services/remove': ({ id }) => {
    for (const r of terms.values()) if (r.serviceId === id) handle({ t: 'close', id: r.id });
    config.services = config.services.filter((x) => x.id !== id);
    save();
    return config;
  },
  'POST /api/services/detect-xampp': ({ path: dir }) => {
    const found = detectXampp(dir ? path.resolve(str(dir)) : undefined);
    if (!found.length) throw fail('XAMPP not found. Install it (apachefriends.org) or pick its folder.', 404);
    for (const svc of found) if (!config.services.some((x) => x.id === svc.id)) config.services.push(svc);
    save(); checkHealth();
    return config;
  },
  'POST /api/log': ({ path: p }) => {
    const file = str(p);
    // Only files a service declared as its log can be read.
    if (!config.services.some((s) => s.logs.includes(file))) throw fail('Not a registered log file', 403);
    if (!fs.existsSync(file)) return { text: '', missing: true };
    return tail(file);
  },
  'POST /api/docker/logs': async ({ id }) => {
    const out = await dockerLogs(str(id));
    if (out === null) throw fail('Unknown container', 404);
    return { text: out, size: out.length, mtime: Date.now() };
  },

  // .env
  'POST /api/env/read': ({ file }) => ({ text: fs.readFileSync(envFile(str(file)), 'utf8') }),
  'POST /api/env/write': ({ file, text }) => {
    const f = envFile(str(file));
    // Keep the previous version: a bad save must never lose secrets.
    const dir = path.join(DATA, 'env-backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(f, path.join(dir, `${path.basename(path.dirname(f))}${path.basename(f)}.${Date.now()}`));
    fs.writeFileSync(f, str(text));
    return { ok: true };
  },

  // databases
  'POST /api/db/list': async () => ({ ...(await db.list()), schedule: config.backup }),
  'POST /api/db/backup': ({ name }) => db.backup(str(name)),
  'POST /api/db/restore': ({ file }) => db.restore(str(file)),
  'POST /api/db/delete-backup': ({ file }) => db.remove(str(file)),
  'POST /api/db/credentials': ({ user, password }) => {
    config.mysql = { user: (str(user) || 'root').slice(0, 64), password: str(password) };
    save();
    return { ok: true };
  },
  'POST /api/db/schedule': ({ enabled, everyHours, keep, beforePull }) => {
    config.backup = {
      ...config.backup, enabled: !!enabled, beforePull: beforePull !== false,
      everyHours: Math.min(Math.max(Number(everyHours) || 24, 1), 168), keep: Math.min(Math.max(Number(keep) || 7, 1), 100),
    };
    save();
    return config.backup;
  },
  // requirements checklist per project
  'POST /api/requirements': async ({ projectId }) => {
    const p = config.projects.find((x) => x.id === projectId);
    if (!p) throw fail('Unknown project', 404);
    const listening = await listeningPids();
    const databases = listening[3306] ? await db.databases().then((d) => d.map((x) => x.name), () => null) : null;
    return checkProject(p, { listening, databases, services: config.services, needed: neededServices(p) });
  },
  'POST /api/requirements/fix': async ({ projectId, kind, arg }) => {
    const p = config.projects.find((x) => x.id === projectId);
    if (!p) throw fail('Unknown project', 404);
    const target = str(arg);
    if (kind === 'db') {
      if (target !== p.db) throw fail('Not this project\'s database');
      await db.create(target);
      return { message: `Created database ${target}` };
    }
    if (kind === 'env') {
      // Only an example file sitting in one of this project's folders.
      const dirs = new Set([p.path, ...p.apps.map((a) => a.path)]);
      if (!dirs.has(path.dirname(target)) || !/^\.env\.(example|sample|template|dist)$/i.test(path.basename(target)) || !fs.existsSync(target)) throw fail('Not an .env example of this project', 403);
      const message = fillEnv(target);
      rescan();
      return { message };
    }
    throw fail('Unknown fix');
  },
  'POST /api/db/open-folder': () => { fs.mkdirSync(db.DIR, { recursive: true }); spawn(EXPLORER, [db.DIR], { detached: true, stdio: 'ignore' }).unref(); return { ok: true }; },

  // git
  'POST /api/git/status': async ({ projectId }) => {
    const dir = repoOf(projectId);
    const [st, history] = await Promise.all([git.status(dir), git.log(dir)]);
    return { ...st, log: history };
  },
  'POST /api/git/diff': async ({ projectId, file }) => {
    const dir = repoOf(projectId);
    // Only diff files git itself reports as changed, never an arbitrary path.
    const f = (await git.status(dir)).files.find((x) => x.path === file);
    if (!f) throw fail('File is no longer changed. Refresh.', 404);
    return { diff: await git.diff(dir, f.path, f.untracked) };
  },
  'POST /api/git/show': async ({ projectId, hash }) => ({ diff: await git.show(repoOf(projectId), str(hash)) }),
  'POST /api/git/commit': async ({ projectId, message, files }) => {
    const dir = repoOf(projectId);
    const changed = new Set((await git.status(dir)).files.map((f) => f.path));
    const pick = Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string' && changed.has(f)) : [];
    const out = await git.commit(dir, str(message), pick);
    refreshGit();
    return { output: out };
  },
  'POST /api/git/remote': async ({ projectId, action }) => {
    // A pull can bring migrations: snapshot the project's database first (best effort, MySQL may be off).
    let note = '';
    const proj = config.projects.find((x) => x.id === projectId);
    if (action === 'pull' && proj?.db && config.backup?.beforePull !== false) {
      try { note = `DB backup: ${(await db.backup(proj.db, '-pre-pull')).file}\n`; } catch {}
    }
    const out = note + await git.remote(repoOf(projectId), str(action));
    refreshGit();
    return { output: out };
  },

  // accounts: the host PC manages everyone, a remote user only themself
  'GET /api/users': (_, { local, session }) => {
    const s = session as Session;
    return local
      ? { users: auth.users(), sessions: auth.allSessions().map((x) => ({ ...x, current: x.id === s.tokenHash })) }
      : { users: auth.users().filter((u) => u.id === s.userId), sessions: auth.sessions(s.userId).map((x) => ({ ...x, current: x.id === s.tokenHash })) };
  },
  'POST /api/users/create': ({ username, password }) => { auth.createUser(username, password); return { ok: true }; },
  'POST /api/users/delete': ({ id }) => { auth.deleteUser(Number(id)); return { ok: true }; },
  'POST /api/users/password': ({ id, password }, ctx) => { auth.setPassword(targetUser(id, ctx), password); return { ok: true }; },
  'POST /api/users/mfa/start': async ({ id }, ctx) => {
    const { secret, uri } = auth.startMfa(targetUser(id, ctx));
    return { secret, qr: await QRCode.toString(uri, { type: 'svg', margin: 1 }) };
  },
  'POST /api/users/mfa/confirm': ({ id, code }, ctx) => { auth.confirmMfa(targetUser(id, ctx), str(code).trim()); return { ok: true }; },
  'POST /api/users/mfa/disable': ({ id, code }, ctx) => {
    const uid = targetUser(id, ctx);
    // Remotely, turning MFA off needs a current code: a stolen session cookie alone is not enough.
    if (!ctx.local) auth.confirmMfa(uid, str(code).trim());
    auth.disableMfa(uid);
    return { ok: true };
  },
  'POST /api/sessions/revoke': ({ id }, { local, session }) => { auth.revoke(str(id), local ? null : (session as Session).userId); return { ok: true }; },

  // host PC
  'POST /api/autostart': ({ enabled }) => { setLoginAutostart(!!enabled); return { enabled: loginAutostart() }; },
  'POST /api/shortcut': async () => ({ path: await desktopShortcut() }),
};

// Things that act on the host PC's desktop (or manage other people's accounts) are refused from another machine.
const LOCAL_ONLY = new Set(['POST /api/pick-folder', 'POST /api/open', 'POST /api/open-wt', 'POST /api/db/open-folder',
  'POST /api/autostart', 'POST /api/shortcut', 'POST /api/users/create', 'POST /api/users/delete']);
const PUBLIC = new Set(['/login.html', '/style.css']);
const isPublic = (req: IncomingMessage, pathname: string) => req.method === 'GET' && (PUBLIC.has(pathname) || pathname.startsWith('/vendor/'));

// phpMyAdmin through Devdeck: Apache sees a local request (XAMPP allows it only from localhost) and Devdeck's login already ran.
function proxyPma(req: IncomingMessage, res: ServerResponse) {
  const port = config.services.find((s) => s.id === 'xampp-apache')?.port || 80;
  const cookie = (req.headers.cookie || '').split(';').filter((c) => !c.trim().startsWith('dd_session=')).join(';');
  const headers = { ...req.headers, host: port === 80 ? 'localhost' : `localhost:${port}`, cookie };
  delete headers.origin;
  const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers }, (r) => {
    const h = { ...r.headers };
    if (h.location) h.location = h.location.replace(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/, '');
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) send(res, 502, 'phpMyAdmin is not running. Start "phpMyAdmin" and "MySQL" in Devdeck > Services.'); });
  req.pipe(up);
}

async function onRequest(req: IncomingMessage, res: ServerResponse) {
  // Host check blocks DNS rebinding; same-origin check blocks other sites from triggering commands.
  if (!hostOk(req.headers.host)) return send(res, 403, 'bad host');
  const url = new URL(req.url || '/', 'http://x');
  const { pathname } = url;
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return send(res, 403, 'bad origin');
  const ip = req.socket.remoteAddress || '';
  const local = isLoopback(ip);
  const session = auth.session(req);
  // Before the first account exists only this PC gets in, and only to create that account.
  const setup = local && !auth.hasUsers();

  if (req.method === 'GET' && pathname === '/api/setup-state') return send(res, 200, { setup, local, hasUsers: auth.hasUsers() });
  if (req.method === 'POST' && pathname === '/api/setup') {
    if (!setup) return send(res, 403, { error: 'Setup is already done.' });
    const body = await readBody(req).catch((): Body => ({}));
    try { auth.createUser(body.user, body.password); } catch (e) { return send(res, (e as HttpError).status || 400, { error: (e as Error).message }); }
    const r = auth.login(ip, body.user, body.password, req.headers['user-agent']);
    if ('token' in r) res.setHeader('set-cookie', auth.cookie(r.token));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && (pathname === '/api/login' || pathname === '/api/login/mfa')) {
    if (!auth.hasUsers()) return send(res, 403, { error: local ? 'Create your account first.' : 'Network access is off. Create an account on the host PC first.' });
    const body = await readBody(req).catch((): Body => ({}));
    const agent = req.headers['user-agent'];
    const r = pathname === '/api/login' ? auth.login(ip, body.user, body.password, agent) : auth.loginMfa(ip, body.ticket, body.code, agent);
    if ('error' in r) return send(res, r.status, { error: r.error });
    if ('mfa' in r) return send(res, 200, { mfa: true, ticket: r.ticket });
    res.setHeader('set-cookie', auth.cookie(r.token));
    return send(res, 200, { ok: true });
  }
  if (!session) {
    if (!auth.hasUsers() && !local) return send(res, 403, 'Network access is off. Open Devdeck on the host PC and create an account.');
    if (isPublic(req, pathname)) return serveStatic(res, pathname);
    if (pathname.startsWith('/api/')) return send(res, 401, { error: setup ? 'Create your account first' : 'Login required' });
    return redirect(res, '/login.html');
  }
  if (pathname === '/phpmyadmin' || pathname.startsWith('/phpmyadmin/')) return proxyPma(req, res);
  if (req.method === 'POST' && pathname === '/api/logout') {
    auth.logout(session.tokenHash);
    res.setHeader('set-cookie', auth.cookie('', 0));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/api/me') {
    return send(res, 200, {
      local, user: session.user, userId: session.userId, hasUsers: auth.hasUsers(),
      mfa: !!auth.users().find((u) => u.id === session.userId)?.totp_enabled,
      urls: lanAddresses().map((a) => `http://${a}:${PORT}`), hostname: os.hostname(), autostart: local ? loginAutostart() : null,
    });
  }
  const key = `${req.method} ${pathname}`;
  if (!local && LOCAL_ONLY.has(key)) return send(res, 403, { error: 'Only available on the host PC.' });
  if (req.method === 'GET' && pathname === '/api/icon') return serveIcon(res, url.searchParams.get('id'));
  const route = api[key];
  if (!route) return req.method === 'GET' ? serveStatic(res, pathname) : send(res, 404, 'not found');
  try {
    const out = await route(req.method === 'GET' ? {} : await readBody(req), { local, session });
    send(res, 200, out === config ? publicConfig() : out);
  } catch (e) {
    send(res, (e as HttpError).status || 500, { error: (e as Error).message });
  }
}

const server = http.createServer((req, res) => { onRequest(req, res).catch((e) => { if (!res.headersSent) send(res, 500, { error: (e as Error).message }); }); });

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!hostOk(req.headers.host) || !sameOrigin(req) || !auth.session(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ t: 'init', health, git: gitSummary, docker, stats, machine, terms: [...terms.values()].map((r) => ({ ...meta(r), buf: r.buf })) }));
  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg && typeof msg.t === 'string') handle(msg);
  });
  ws.on('close', () => clients.delete(ws));
});

// ---------- startup ----------
if (config.roots.length || config.manual.length) rescan();
// XAMPP installed? Its MySQL and Apache (phpMyAdmin) show up as services without any setup.
for (const svc of detectXampp()) if (!config.services.some((x) => x.id === svc.id)) { config.services.push(svc); save(); }
const apacheSvc = config.services.find((s) => s.id === 'xampp-apache');
if (apacheSvc && apacheSvc.name !== 'phpMyAdmin') { Object.assign(apacheSvc, { name: 'phpMyAdmin', url: '/phpmyadmin/' }); save(); }
const mysqlSvc = config.services.find((s) => s.id === 'xampp-mysql');
if (mysqlSvc?.url?.startsWith('http://localhost/phpmyadmin')) { mysqlSvc.url = '/phpmyadmin/'; save(); }
// Services and projects marked to start with Devdeck (skip a service whose port is already taken).
listeningPids().then((pids) => {
  for (const s of config.services) if (s.autostart && !(s.port && pids[s.port])) startService(s.id);
  for (const p of config.projects) if (p.bootStart) startAll(p.id);
});
refreshGit();
refreshDocker();

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') { console.log(`Devdeck is already running: http://localhost:${PORT}`); process.exit(0); }
  throw e;
});
server.listen(PORT, HOST, () => console.log(`Devdeck: http://localhost:${PORT}  (network: ${lanAddresses().map((a) => `http://${a}:${PORT}`).join(', ')})`));
