// Everything that runs: terminals (scripts, shells, services), port health, CPU/RAM, Docker.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import pty, { type IPty } from '@lydell/node-pty';
import { readScripts, runCmd, installState, PMS } from './scan.ts';
import { findExe } from './git.ts';
import {
  config, save, findApp, broadcast, isDir, run, psQuote,
  ROOT, SYS, POWERSHELL, TASKKILL,
} from './core.ts';
import type { ClientMsg, DockerContainer, Project, DockerState, Health, History, Machine, PackageManager, PortOwner, Stats, TermMeta } from './types.ts';

const BUF_LIMIT = 200_000;
export const SERVICES = '__services'; // pseudo project that groups service terminals

/** A terminal Devdeck owns. Survives restarts of its process (same id, same tab). */
interface Term {
  id: string;
  projectId: string;
  title: string;
  buf: string;
  cwd: string;
  appId?: string;
  serviceId?: string;
  script?: string | null;
  pm?: PackageManager;
  cmd?: string;
  stopCmd?: string | null;
  fixedPort?: number | null;
  install?: boolean;
  pty?: IPty | null;
  status?: 'running' | 'exited';
  code?: number | null;
  port?: number | null;
  conflict?: number | null;
  killed?: boolean;
  restart?: boolean;
  closing?: boolean;
  startedAt?: number;
  endedAt?: number | null;
  cols?: number;
  rows?: number;
  forceKill?: NodeJS.Timeout;
}

export const terms = new Map<string, Term>();
let nextId = 1;

export const meta = (r: Term): TermMeta => ({
  id: r.id, appId: r.appId, projectId: r.projectId, serviceId: r.serviceId, title: r.title, script: r.script,
  status: r.status || 'exited', code: r.code ?? null, port: r.port ?? null, killed: !!r.killed,
  startedAt: r.startedAt, endedAt: r.endedAt, conflict: r.conflict,
});
const CONFLICT_RE = /EADDRINUSE[^\n]*?:(\d{2,5})|address already in use[^\n]*?:(\d{2,5})|port (\d{2,5}) is (?:already )?in use/i;
const PORT_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/;
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
const scriptCmd = (pm: PackageManager, script: string) => runCmd(pm, script).map((x, i) => i === 2 ? psQuote(x) : x).join(' ');

function startPty(rec: Term) {
  const cmd = rec.cmd || (rec.script && rec.pm ? scriptCmd(rec.pm, rec.script) : '');
  const p = pty.spawn(POWERSHELL, cmd ? ['-NoLogo', '-Command', cmd] : ['-NoLogo'], {
    name: 'xterm-256color', cols: rec.cols || 120, rows: rec.rows || 30, cwd: rec.cwd,
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  Object.assign(rec, { pty: p, status: 'running', code: null, port: rec.fixedPort || null, killed: false, startedAt: Date.now(), endedAt: null, conflict: null });
  p.onData((data) => {
    rec.buf = (rec.buf + data).slice(-BUF_LIMIT);
    broadcast({ t: 'output', id: rec.id, data });
    if (!rec.port || !rec.conflict) {
      const tail = stripAnsi(rec.buf.slice(-4000));
      const m = !rec.port && tail.match(PORT_RE);
      if (m) { rec.port = Number(m[1]); broadcast({ t: 'term', term: meta(rec) }); }
      const c = !rec.conflict && tail.match(CONFLICT_RE);
      if (c) { rec.conflict = Number(c[1] || c[2] || c[3]); broadcast({ t: 'term', term: meta(rec) }); checkHealth(); }
    }
  });
  p.onExit(({ exitCode }) => {
    if (rec.pty !== p) return; // stale exit from a pty that was already replaced
    clearTimeout(rec.forceKill);
    Object.assign(rec, { pty: null, status: 'exited', code: exitCode, endedAt: Date.now() });
    if (rec.restart) {
      rec.restart = false;
      const line = '\r\n\x1b[2m--- restart ---\x1b[0m\r\n';
      rec.buf += line;
      broadcast({ t: 'output', id: rec.id, data: line });
      startPty(rec);
    }
    if (rec.install) {
      const { app } = findApp(rec.appId);
      if (app) { app.install = installState(app.path); save(); broadcast({ t: 'config' }); }
    }
    if (rec.closing) { terms.delete(rec.id); broadcast({ t: 'closed', id: rec.id }); return; }
    broadcast({ t: 'term', term: meta(rec) });
  });
  broadcast({ t: 'term', term: meta(rec) });
}

function installApp(appId: string) {
  const { project, app } = findApp(appId);
  if (!project || !app || !['npm', 'pnpm', 'yarn', 'bun'].includes(app.pm)) return;
  let rec = [...terms.values()].find((r) => r.appId === appId && r.install);
  if (rec?.status === 'running') return;
  if (!rec) {
    rec = { id: String(nextId++), appId, projectId: project.id, install: true, cwd: app.path, buf: '', title: `${app.name} : install` };
    terms.set(rec.id, rec);
  }
  rec.cmd = `${app.pm} install`;
  startPty(rec);
}

function spawnTerm(appId: string, script: string | null) {
  const { project, app } = findApp(appId);
  if (!project || !app) return;
  if (script) {
    // Re-read package.json: only real scripts with a known package manager ever reach the shell.
    if (!PMS.includes(app.pm) || !readScripts(app.path, app.pm)?.includes(script)) return;
    const existing = [...terms.values()].find((r) => r.appId === appId && r.script === script);
    if (existing) { if (existing.status !== 'running') startPty(existing); return; }
  }
  const rec: Term = {
    id: String(nextId++), appId, projectId: project.id, script, pm: app.pm, cwd: app.path, buf: '',
    title: `${app.name}${script ? ` : ${script}` : ' : shell'}`,
  };
  terms.set(rec.id, rec);
  startPty(rec);
}

// Windows: killing the shell leaves node.exe children holding ports, so kill the whole tree.
const forceKill = (rec: Term) => rec.pty && execFile(TASKKILL, ['/T', '/F', '/PID', String(rec.pty.pid)], () => {});
function killTree(rec: Term) {
  if (!rec.pty) return;
  rec.killed = true;
  // Services like MySQL get a graceful stop command first; hard kill only if it hangs.
  if (!rec.stopCmd) { forceKill(rec); return; }
  execFile(POWERSHELL, ['-NoProfile', '-Command', rec.stopCmd], { windowsHide: true, cwd: rec.cwd }, () => {});
  clearTimeout(rec.forceKill);
  rec.forceKill = setTimeout(() => forceKill(rec), 15000);
}

export function startService(serviceId: string) {
  const svc = config.services.find((s) => s.id === serviceId);
  if (!svc) return;
  let rec = [...terms.values()].find((r) => r.serviceId === serviceId);
  if (rec?.status === 'running') return;
  if (!rec) {
    rec = { id: String(nextId++), serviceId, projectId: SERVICES, buf: '', title: svc.name, cwd: ROOT };
    terms.set(rec.id, rec);
  }
  // Re-read the definition on every start so edits apply.
  Object.assign(rec, { title: svc.name, cmd: svc.cmd, stopCmd: svc.stopCmd || null, cwd: isDir(svc.cwd) ? svc.cwd : ROOT, fixedPort: svc.port || null });
  startPty(rec);
}

export function killAll() {
  for (const rec of terms.values()) {
    if (rec.pty) try { execFileSync(TASKKILL, ['/T', '/F', '/PID', String(rec.pty.pid)], { stdio: 'ignore' }); } catch {}
  }
}

/** Project "Start all": its services first (waiting for their ports), then its starred scripts. */
/** Services a project needs: the ones ticked in its Overview, plus MySQL when its .env / wp-config names a database. */
export function neededServices(p: Project): { id: string; auto: boolean }[] {
  const out = (p.services || []).map((id) => ({ id, auto: false }));
  if (p.db && !out.some((s) => s.id === 'xampp-mysql') && config.services.some((s) => s.id === 'xampp-mysql')) out.push({ id: 'xampp-mysql', auto: true });
  return out;
}

/** Bring up what the project needs before its scripts run. Anything already listening (even started outside Devdeck) is left alone. */
async function ensureServices(p: Project) {
  const deps = neededServices(p).map(({ id }) => config.services.find((s) => s.id === id)).filter((s) => !!s);
  if (deps.length) {
    const pids = await listeningPids();
    const pending = deps.filter((s) => !(s.port && pids[s.port]));
    for (const s of pending) startService(s.id);
    // Wait (max 30 s) until every dependency with a port answers, so the backend doesn't boot into "connection refused".
    for (let i = 0; i < 60 && pending.some((s) => s.port); i++) {
      const now = await listeningPids();
      if (pending.every((s) => !s.port || now[s.port])) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (pending.length) await checkHealth(); // show the dependencies as up right away, not on the next 3 s tick
  }
}

export async function startAll(projectId: string) {
  const p = config.projects.find((x) => x.id === projectId);
  if (!p) return;
  await ensureServices(p);
  for (const a of p.apps) if (a.autostart) spawnTerm(a.id, a.autostart);
}

type Handler<T extends ClientMsg['t']> = (msg: Extract<ClientMsg, { t: T }>) => unknown;
export const handlers: { [K in ClientMsg['t']]: Handler<K> } = {
  // A script (not a plain shell) first gets the services its project needs.
  spawn: async ({ appId, script }) => {
    const { project } = findApp(appId);
    if (script && project) await ensureServices(project);
    spawnTerm(appId, script || null);
  },
  restart: async ({ id }) => {
    const r = terms.get(id);
    if (!r) return;
    if (r.pty) { r.restart = true; killTree(r); return; }
    const p = r.script && config.projects.find((x) => x.id === r.projectId);
    if (p) await ensureServices(p);
    startPty(r);
  },
  input: ({ id, data }) => terms.get(id)?.pty?.write(data),
  resize: ({ id, cols, rows }) => {
    const rec = terms.get(id);
    if (!rec || !(cols > 1 && rows > 1)) return;
    Object.assign(rec, { cols, rows });
    try { rec.pty?.resize(cols, rows); } catch {}
  },
  kill: ({ id }) => { const r = terms.get(id); if (r) killTree(r); },
  close: ({ id }) => {
    const r = terms.get(id);
    if (!r) return;
    if (r.pty) { r.closing = true; killTree(r); } else { terms.delete(id); broadcast({ t: 'closed', id }); }
  },
  startAll: ({ projectId }) => startAll(projectId),
  stopAll: ({ projectId }) => { for (const r of terms.values()) if (r.projectId === projectId) killTree(r); },
  startService: ({ serviceId }) => startService(serviceId),
  stopService: ({ serviceId }) => {
    const rec = [...terms.values()].find((r) => r.serviceId === serviceId && r.pty);
    if (rec) return killTree(rec);
    // Started outside Devdeck (e.g. XAMPP panel): only a graceful stop command can reach it.
    const svc = config.services.find((s) => s.id === serviceId);
    if (svc?.stopCmd) execFile(POWERSHELL, ['-NoProfile', '-Command', svc.stopCmd], { windowsHide: true, cwd: isDir(svc.cwd) ? svc.cwd : ROOT }, () => checkHealth());
  },
  install: ({ appId }) => installApp(appId),
  // Only a process that currently owns a port Devdeck watches can be killed this way.
  killPid: ({ pid }) => {
    if (Object.values(health).some((h) => h && h.pid === pid)) execFile(TASKKILL, ['/T', '/F', '/PID', String(pid)], () => setTimeout(checkHealth, 500));
  },
  docker: ({ action, id }) => dockerAction(action, id),
};
export function handle(msg: ClientMsg) {
  (handlers[msg.t] as Handler<typeof msg.t> | undefined)?.(msg as never);
}

// ---------- port health: who listens, since when (works for things started outside Devdeck too) ----------
export let health: Health = {};
export async function listeningPids(): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  for (const line of (await run(path.join(SYS, 'NETSTAT.EXE'), ['-ano', '-p', 'TCP'])).split('\n')) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m) map[m[1]] ??= Number(m[2]);
  }
  return map;
}
const procCache = new Map<number, Omit<PortOwner, 'pid'>>();
async function procInfo(pids: number[]) {
  const missing = pids.filter((p) => !procCache.has(p));
  if (!missing.length) return;
  const out = await run(POWERSHELL, ['-NoProfile', '-Command',
    `Get-Process -Id ${missing.join(',')} -ErrorAction SilentlyContinue | % { "$($_.Id)|$($_.ProcessName)|$(([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds())" }`]);
  for (const l of out.trim().split(/\r?\n/)) {
    const [pid, name, at] = l.split('|');
    if (pid) procCache.set(Number(pid), { name, startedAt: Number(at) || null });
  }
  for (const p of missing) if (!procCache.has(p)) procCache.set(p, { name: null, startedAt: null });
}
// Reads the OS listening table instead of connecting: a TCP probe would spam MySQL's log with aborted connections.
export async function checkHealth() {
  const ports = new Set([...config.services.map((s) => s.port), ...[...terms.values()].flatMap((r) => [r.port, r.conflict])].filter((p): p is number => !!p));
  const pids = ports.size ? await listeningPids() : {};
  // PIDs get reused; forget processes that stopped listening so a new owner gets a fresh start time.
  const live = new Set(Object.values(pids));
  for (const pid of procCache.keys()) if (!live.has(pid)) procCache.delete(pid);
  await procInfo([...new Set([...ports].map((p) => pids[p]).filter(Boolean))]);
  const next: Health = {};
  for (const p of ports) next[p] = pids[p] ? { pid: pids[p], ...procCache.get(pids[p]) } : false;
  if (JSON.stringify(next) !== JSON.stringify(health)) { health = next; broadcast({ t: 'health', health }); }
}
setInterval(checkHealth, 3000);

// ---------- CPU / RAM: per process tree (npm -> node -> vite all count) and for the whole PC ----------
export let stats: Stats = {};
export let machine: Machine | null = null;
const HISTORY_POINTS = 720; // 1 hour at one sample per 5 s
const history: History = { machine: [], series: {}, labels: {} };
const prevCpu = new Map<string, { t: number; at: number }>();
let prevMachine: { idle: number; total: number } | null = null;

function treeUsage(rootPid: number, procs: Map<number, { mem: number; cpu: number }>, kids: Map<number, number[]>) {
  let mem = 0, cpu = 0;
  const seen = new Set<number>();
  for (const stack = [rootPid]; stack.length;) {
    const pid = stack.pop() as number;
    const p = procs.get(pid);
    if (seen.has(pid) || !p) continue; // seen: PID reuse can fake a cycle
    seen.add(pid);
    mem += p.mem;
    cpu += p.cpu;
    stack.push(...(kids.get(pid) || []));
  }
  return { mem, cpu };
}
function machineSample(): Machine {
  const cpus = os.cpus();
  const idle = cpus.reduce((s, c) => s + c.times.idle, 0);
  const total = cpus.reduce((s, c) => s + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq, 0);
  const cpu = prevMachine && total > prevMachine.total ? Math.round((1 - (idle - prevMachine.idle) / (total - prevMachine.total)) * 1000) / 10 : null;
  prevMachine = { idle, total };
  return { cpu, memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(), uptime: os.uptime() };
}
const push = <T>(list: T[], item: T) => { list.push(item); if (list.length > HISTORY_POINTS) list.shift(); };

/** Label a usage key for charts: project / script, or the service name. */
function labelFor(key: string): string {
  if (key.startsWith('t')) {
    const r = terms.get(key.slice(1));
    const project = config.projects.find((p) => p.id === r?.projectId)?.name;
    return r ? (project ? `${project} / ${r.title}` : r.title) : key;
  }
  const port = Number(key.slice(1));
  return config.services.find((s) => s.port === port)?.name || `:${port}`;
}

async function refreshStats() {
  const now = Date.now();
  machine = machineSample();
  push(history.machine, { at: now, cpu: machine.cpu, mem: machine.memUsed, memTotal: machine.memTotal });

  const roots: Record<string, number> = {};
  for (const r of terms.values()) if (r.pty) roots[`t${r.id}`] = r.pty.pid;
  for (const [port, h] of Object.entries(health)) {
    // A service Devdeck started is already counted through its terminal.
    if (h && !Object.values(roots).includes(h.pid)) roots[`p${port}`] = h.pid;
  }
  const next: Stats = {};
  if (Object.keys(roots).length) {
    const out = await run(POWERSHELL, ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.WorkingSetSize),$($_.KernelModeTime + $_.UserModeTime)" }']);
    const procs = new Map<number, { mem: number; cpu: number }>(), kids = new Map<number, number[]>();
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid, mem, cpu] = line.split(',').map(Number);
      if (!pid) continue;
      procs.set(pid, { mem, cpu });
      if (pid !== ppid) kids.set(ppid, [...(kids.get(ppid) || []), pid]);
    }
    const cores = os.cpus().length;
    for (const [key, pid] of Object.entries(roots)) {
      const u = treeUsage(pid, procs, kids);
      const prev = prevCpu.get(key);
      // CPU time is in 100 ns units; % of the whole machine, like Task Manager.
      const pct = prev && u.cpu >= prev.t ? ((u.cpu - prev.t) / ((now - prev.at) * 1e4 * cores)) * 100 : null;
      prevCpu.set(key, { t: u.cpu, at: now });
      next[key] = { mem: u.mem, cpu: pct === null ? null : Math.round(pct * 10) / 10 };
      push(history.series[key] ??= [], { at: now, cpu: next[key].cpu, mem: u.mem });
      history.labels[key] = labelFor(key);
    }
  }
  for (const k of prevCpu.keys()) if (!(k in roots)) prevCpu.delete(k);
  // Keep a stopped process's line for the rest of the hour, then drop it.
  for (const [k, list] of Object.entries(history.series)) {
    if (!(k in roots) && (list.at(-1)?.at ?? 0) < now - HISTORY_POINTS * 5000) { delete history.series[k]; delete history.labels[k]; }
  }
  stats = next;
  broadcast({ t: 'stats', stats, machine, at: now });
}
setInterval(() => refreshStats().catch(() => {}), 5000);
export const statsHistory = (): History => history;

// ---------- Docker (only when the CLI is installed) ----------
// PATH of an already running Devdeck may predate the Docker install, so also check the default location.
export const DOCKER = findExe('docker')
  || [path.join(process.env.ProgramFiles || 'C:/Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')].find((f) => fs.existsSync(f)) || null;
export let docker: DockerState = { available: !!DOCKER, running: false, containers: [] };
export async function refreshDocker() {
  if (!DOCKER) return;
  const out = await new Promise<string | null>((resolve) => execFile(DOCKER, ['ps', '-a', '--no-trunc', '--format', '{{json .}}'],
    { windowsHide: true, timeout: 8000 }, (e, so) => resolve(e ? null : so)));
  // null = CLI present but the engine (Docker Desktop) is not running
  const containers = (out || '').split('\n').filter(Boolean).flatMap((l): DockerContainer[] => {
    try {
      const c = JSON.parse(l);
      return [{ ID: c.ID.slice(0, 12), Names: c.Names, Image: c.Image, State: c.State, Status: c.Status, Ports: c.Ports, Compose: c.Labels?.match(/com\.docker\.compose\.project=([^,]+)/)?.[1] || null }];
    } catch { return []; }
  });
  const next = { available: true, running: out !== null, containers };
  if (JSON.stringify(next) !== JSON.stringify(docker)) { docker = next; broadcast({ t: 'docker', docker }); }
}
function dockerAction(action: string, id: string) {
  if (!DOCKER || !['start', 'stop', 'restart'].includes(action) || !docker.containers.some((c) => c.ID === id)) return;
  execFile(DOCKER, [action, id], { windowsHide: true }, () => refreshDocker());
}
export function dockerLogs(id: string) {
  if (!DOCKER || !docker.containers.some((c) => c.ID === id)) return null;
  return new Promise<string>((resolve) => execFile(DOCKER, ['logs', '--tail', '2000', '--timestamps', id],
    { windowsHide: true, maxBuffer: 16 << 20 }, (_e, so, se) => resolve((so || '') + (se || ''))));
}
setInterval(refreshDocker, 5000);

// ---------- Windows Terminal ----------
export function openWt(projectId: string): boolean {
  const p = config.projects.find((x) => x.id === projectId);
  const apps = p?.apps.filter((a): a is typeof a & { autostart: string } => !!a.autostart && PMS.includes(a.pm)) || [];
  if (!p || !apps.length) return false;
  const args = ['-w', p.name.replace(/[^\w.-]/g, '_')];
  apps.forEach((a, i) => {
    if (i) args.push(';');
    args.push('new-tab', '--title', `${p.name} / ${a.name}`, '-d', a.path, 'powershell', '-NoExit', '-Command', scriptCmd(a.pm, a.autostart).replaceAll(';', '\\;'));
  });
  execFile('wt.exe', args, { windowsHide: false }, () => {});
  return true;
}
