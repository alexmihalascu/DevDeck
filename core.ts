// Shared state and helpers: paths, config on disk, project scan, broadcasting to browsers.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { WebSocket } from 'ws';
import { scanAll, merge } from './scan.ts';
import type { App, Config, Project, PublicConfig, ServerMsg, Service } from './types.ts';

export const ROOT = import.meta.dirname;
export const DATA = path.join(ROOT, 'data');
export const PORT = Number(process.env.PORT) || 4321;
// Listens on the network, but nothing past the login gate answers until you sign in.
export const HOST = process.env.HOST || '0.0.0.0';

// Absolute paths: a same-named exe inside a project folder must never be picked up.
const WINDIR = process.env.SystemRoot || 'C:/Windows';
export const SYS = path.join(WINDIR, 'System32');
export const POWERSHELL = path.join(SYS, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const TASKKILL = path.join(SYS, 'taskkill.exe');
export const CMD = path.join(SYS, 'cmd.exe');
export const EXPLORER = path.join(WINDIR, 'explorer.exe');

export type HttpError = Error & { status: number };
export const fail = (message: string, status = 400): HttpError => Object.assign(new Error(message), { status });
export const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
/** Run a program, resolve with stdout ('' on failure). Never throws. */
export const run = (file: string, args: string[]) => new Promise<string>((resolve) =>
  execFile(file, args, { windowsHide: true, maxBuffer: 8 << 20 }, (_e, out) => resolve(out || '')));
export const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;

// ---------- config ----------
const CONFIG_FILE = path.join(DATA, 'config.json');
export const config: Config = { roots: [], manual: [], projects: [], services: [], mysql: { user: 'root', password: '' } };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch {}
export const save = () => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
};
// Secrets (MySQL password) never leave the server.
export const publicConfig = (): PublicConfig => ({ ...config, mysql: { user: config.mysql?.user || 'root', hasPassword: !!config.mysql?.password } });

// ---------- XAMPP: used for MySQL + phpMyAdmin ----------
const XAMPP_DIRS = ['C:\\xampp', 'D:\\xampp', 'C:\\Program Files\\xampp'];
export function findXampp(dir?: string): string | null {
  return [dir, ...XAMPP_DIRS].filter((d): d is string => !!d)
    .find((d) => fs.existsSync(path.join(d, 'xampp-control.exe')) || fs.existsSync(path.join(d, 'mysql', 'bin', 'mysqld.exe'))) || null;
}
export const XAMPP = findXampp();

export const cleanService = (b: Partial<Record<keyof Service, unknown>>): Service => ({
  id: typeof b.id === 'string' && b.id ? b.id : `svc-${Date.now().toString(36)}`,
  name: String(b.name || '').trim().slice(0, 60) || 'Service',
  cmd: String(b.cmd || '').trim(),
  stopCmd: String(b.stopCmd || '').trim(),
  cwd: String(b.cwd || '').trim(),
  port: Number(b.port) > 0 && Number(b.port) < 65536 ? Number(b.port) : null,
  url: /^(https?:\/\/|\/)/.test(String(b.url || '')) ? String(b.url) : '',
  logs: (Array.isArray(b.logs) ? b.logs : String(b.logs || '').split('\n')).map((l) => String(l).trim()).filter(Boolean),
  autostart: b.autostart === true || b.autostart === 'on',
});

export function detectXampp(dir?: string): Service[] {
  const base = findXampp(dir);
  if (!base) return [];
  const j = (...p: string[]) => path.join(base, ...p);
  const found: Partial<Service>[] = [];
  if (fs.existsSync(j('mysql', 'bin', 'mysqld.exe'))) found.push({
    id: 'xampp-mysql', name: 'MySQL', cwd: j('mysql'), port: 3306, url: fs.existsSync(j('phpMyAdmin')) ? '/phpmyadmin/' : '',
    cmd: `& '${j('mysql', 'bin', 'mysqld.exe')}' --defaults-file='${j('mysql', 'bin', 'my.ini')}' --standalone`,
    stopCmd: `& '${j('mysql', 'bin', 'mysqladmin.exe')}' -u root shutdown`,
    logs: [j('mysql', 'data', 'mysql_error.log')],
  });
  if (fs.existsSync(j('apache', 'bin', 'httpd.exe'))) found.push({
    id: 'xampp-apache', name: 'phpMyAdmin', cwd: j('apache'), port: 80, url: '/phpmyadmin/',
    cmd: `& '${j('apache', 'bin', 'httpd.exe')}'`, stopCmd: '',
    logs: [j('apache', 'logs', 'error.log'), j('apache', 'logs', 'access.log')],
  });
  return found.map(cleanService);
}

// ---------- projects ----------
const XAMPP_SAMPLES = new Set(['dashboard', 'img', 'webalizer', 'xampp']);
export function rescan() {
  const htdocs = XAMPP && path.join(XAMPP, 'htdocs').toLowerCase();
  config.projects = merge(config.projects, scanAll(config)
    .filter((p) => p.id.toLowerCase() !== ROOT.toLowerCase()) // Devdeck itself is not a project
    .filter((p) => !(htdocs && path.dirname(p.path).toLowerCase() === htdocs && XAMPP_SAMPLES.has(p.name.toLowerCase())))
    .map((p) => htdocs && p.path.toLowerCase().startsWith(htdocs + path.sep)
      ? { ...p, url: `http://localhost/${p.path.slice(htdocs.length + 1).replaceAll('\\', '/')}/` } : p));
  save();
}
export function findApp(appId: string | undefined): { project?: Project; app?: App } {
  for (const p of config.projects) {
    const a = p.apps.find((x) => x.id === appId);
    if (a) return { project: p, app: a };
  }
  return {};
}

// ---------- browsers ----------
export const clients = new Set<WebSocket>();
export const broadcast = (msg: ServerMsg) => { const s = JSON.stringify(msg); for (const c of clients) c.send(s); };
