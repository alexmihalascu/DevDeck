// Shapes shared by the server and the browser. Type-only: imported with `import type`, erased at runtime.

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'composer';
export type InstallState = 'ok' | 'missing' | 'stale';

export interface App {
  id: string;
  name: string;
  path: string;
  pm: PackageManager;
  kind?: 'php';
  scripts: string[];
  cmds: Record<string, string>;
  stack: string[];
  version: string | null;
  install?: InstallState;
  autostart: string | null;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  icon: string | null;
  envFiles: string[];
  db: string | null;
  apps: App[];
  url?: string;
  hidden?: boolean;
  services?: string[];
  bootStart?: boolean;
}

export interface Service {
  id: string;
  name: string;
  cmd: string;
  stopCmd: string;
  cwd: string;
  port: number | null;
  url: string;
  logs: string[];
  autostart: boolean;
}

export interface BackupSchedule {
  enabled: boolean;
  everyHours: number;
  keep: number;
  beforePull: boolean;
  lastRun?: number;
  lastResult?: string[];
}

export interface Config {
  roots: string[];
  manual: string[];
  projects: Project[];
  services: Service[];
  mysql: { user: string; password: string };
  backup?: BackupSchedule;
}

/** What the browser gets: no secrets. */
export interface PublicConfig extends Omit<Config, 'mysql'> {
  mysql: { user: string; hasPassword: boolean };
}

export interface TermMeta {
  id: string;
  projectId: string;
  title: string;
  status: 'running' | 'exited';
  code: number | null;
  port: number | null;
  killed: boolean;
  appId?: string;
  serviceId?: string;
  script?: string | null;
  startedAt?: number;
  endedAt?: number | null;
  conflict?: number | null;
}

export interface PortOwner { pid: number; name?: string | null; startedAt?: number | null }
/** port -> process listening on it, or false */
export type Health = Record<string, PortOwner | false>;
export interface Stat { cpu: number | null; mem: number }
/** 't<termId>' | 'p<port>' -> usage */
export type Stats = Record<string, Stat>;
/** Whole PC: CPU % and memory in bytes. */
export interface Machine { cpu: number | null; memUsed: number; memTotal: number; uptime: number }
/** One sample every 5 s, kept for an hour. */
export interface Sample { at: number; cpu: number | null; mem: number }
export interface History { machine: (Sample & { memTotal: number })[]; series: Record<string, Sample[]>; labels: Record<string, string> }

export interface GitSummary { branch: string | null; upstream: string | null; ahead: number; behind: number; changed: number }

export interface DockerContainer { ID: string; Names: string; Image: string; State: string; Status: string; Ports: string; Compose: string | null }
export interface DockerState { available: boolean; running: boolean; containers: DockerContainer[] }

export interface Me {
  local: boolean;
  user: string | null;
  userId: number | null;
  hasUsers: boolean;
  mfa: boolean | null;
  urls: string[];
  hostname: string;
  autostart: boolean | null;
}

export interface UserRow { id: number; username: string; totp_enabled: boolean; created_at: number; last_login: number | null }
export interface SessionRow { id: string; created_at: number; last_seen: number; ip: string | null; agent: string | null; username?: string; current?: boolean }

export interface GitFile { path: string; x: string; y: string; staged: boolean; untracked: boolean; from?: string }
export interface GitCommit { hash: string; short: string; author: string; at: number; refs: string; subject: string }
export interface GitStatus { branch: string | null; upstream: string | null; ahead: number; behind: number; files: GitFile[] }

export interface Requirement {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'unknown';
  detail: string;
  fix?: { kind: 'install' | 'service' | 'env' | 'db'; arg: string; label: string };
}

export interface DbInfo { name: string; size: number; tables: number; system: boolean }
export interface BackupFile { file: string; name: string; stamp: string; preRestore: boolean; kind: string; size: number; at: number }

/** Server -> browser over the WebSocket. */
export type ServerMsg =
  | { t: 'init'; terms: (TermMeta & { buf: string })[]; health: Health; git: Record<string, GitSummary>; docker: DockerState; stats: Stats; machine: Machine | null }
  | { t: 'output'; id: string; data: string }
  | { t: 'term'; term: TermMeta }
  | { t: 'closed'; id: string }
  | { t: 'health'; health: Health }
  | { t: 'git'; git: Record<string, GitSummary> }
  | { t: 'docker'; docker: DockerState }
  | { t: 'stats'; stats: Stats; machine: Machine; at: number }
  | { t: 'config' };

/** Browser -> server over the WebSocket. */
export type ClientMsg =
  | { t: 'spawn'; appId: string; script: string | null }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'kill' | 'restart' | 'close'; id: string }
  | { t: 'startAll' | 'stopAll'; projectId: string }
  | { t: 'startService' | 'stopService'; serviceId: string }
  | { t: 'install'; appId: string }
  | { t: 'killPid'; pid: number }
  | { t: 'docker'; action: 'start' | 'stop' | 'restart'; id: string };
