// Entry point: boot, live messages from the server, and every click/keyboard action.
import type { History, PublicConfig, ServerMsg } from '../../types.ts';
import { $, dataOf, fmtDur, toast } from './util.ts';
import { api, connect, send } from './net.ts';
import { state, persist, SERVICES } from './state.ts';
import { render, drawStats } from './render.ts';
import { addTerm, removeTerm, focusTerm, queueFit, runScript, openShell } from './terminals.ts';
import { chartHover, pushStats } from './charts.ts';
import { loadDb, loadRequirements } from './views/pages.ts';
import {
  applyTheme, nextTheme, crashed, toggleNotify, renderNotify, openImport, openServiceDialog, openLog, loadLog, stopLogFollow,
  loadGit, gitSelect, gitRun, gitCommit, drawGit, loadEnv, saveEnv, drawEnv, openSettings, loadSettings, drawSettings,
  openPalette, filterPalette, paletteKey, runPalette,
} from './views/panels.ts';

// ---------- live updates ----------
function onMessage(msg: ServerMsg) {
  switch (msg.t) {
    case 'output': state.terms.get(msg.id)?.term.write(msg.data); return;
    case 'stats':
      Object.assign(state, { stats: msg.stats, machine: msg.machine });
      pushStats(msg.at);
      return drawStats();
    case 'config': api<PublicConfig>('GET', '/api/config').then((c) => { state.config = c; render(); }); return;
    case 'init':
      for (const id of [...state.terms.keys()]) removeTerm(id);
      for (const t of msg.terms) addTerm(t, t.buf);
      Object.assign(state, { health: msg.health, git: msg.git, docker: msg.docker, stats: msg.stats, machine: msg.machine });
      break;
    case 'docker': state.docker = msg.docker; break;
    case 'git': {
      state.git = msg.git;
      const v = state.gitView;
      if (v && state.active[v.projectId] === 'git' && !v.busy) loadGit(v.projectId, { keep: true });
      break;
    }
    case 'health':
      if (!!msg.health[3306] !== !!state.health[3306]) setTimeout(() => loadDb(true), 1500);
      state.health = msg.health;
      break;
    case 'term': {
      const t = state.terms.get(msg.term.id);
      const was = t?.meta.status;
      if (t) t.meta = msg.term; else addTerm(msg.term, '');
      const m = msg.term;
      if (was === 'running' && m.status === 'exited' && m.code && !m.killed) crashed(m);
      if (state.pendingFocus === `${m.appId}\n${m.script ?? ''}`) { state.pendingFocus = null; return focusTerm(m); }
      break;
    }
    case 'closed': removeTerm(msg.id); break;
  }
  render();
}

// ---------- clicks ----------
type Handler = (btn: HTMLElement, ids: { pid?: string; aid?: string; tid?: string; sid?: string }) => unknown;
const go = (pid: string, page: string) => { state.active[pid] = page; persist(); render(); };
const saveConfig = async (patch: Partial<PublicConfig>) => { state.config = await api('PUT', '/api/config', { ...state.config, ...patch }); render(); };
const form = (sel: string) => $<HTMLFormElement>(sel);
const field = (f: HTMLFormElement, name: string) => f.elements.namedItem(name) as HTMLInputElement;
async function dbAction(label: string, url: string, body: unknown, done?: (r: any) => void) {
  state.dbBusy = label;
  render();
  try { done?.(await api('POST', url, body)); } catch (err) { toast((err as Error).message, true); }
  state.dbBusy = '';
  await loadDb(true);
  render();
}

const actions: Record<string, Handler> = {
  home: () => { state.selected = null; persist(); render(); },
  select: (_, { pid }) => { state.selected = pid!; persist(); render(); },
  page: (b, { pid }) => go(pid!, b.dataset.page!),
  'env-tab': (_, { pid }) => go(pid!, 'env'),
  focus: (_, { tid }) => { const t = state.terms.get(tid!); if (t) focusTerm(t.meta); },
  run: (b, { aid }) => runScript(aid!, b.dataset.script!),
  shell: (_, { aid }) => openShell(aid!),
  install: (_, { aid }) => { send({ t: 'install', appId: aid! }); toast('Installing dependencies. Output is in the new tab.'); },
  kill: (_, { tid }) => send({ t: 'kill', id: tid! }),
  restart: (_, { tid }) => send({ t: 'restart', id: tid! }),
  close: (_, { tid }) => send({ t: 'close', id: tid! }),
  'start-all': (_, { pid }) => send({ t: 'startAll', projectId: pid! }),
  'stop-all': (_, { pid }) => send({ t: 'stopAll', projectId: pid! }),
  'free-port': (b, { tid }) => { send({ t: 'killPid', pid: Number(b.dataset.pidKill) }); setTimeout(() => send({ t: 'restart', id: tid! }), 1200); },
  auto: (b, { pid, aid }) => saveConfig({ projects: state.config.projects.map((p) => p.id !== pid ? p : { ...p, apps: p.apps.map((a) => a.id !== aid ? a : { ...a, autostart: a.autostart === b.dataset.script ? null : b.dataset.script! }) }) }),
  hide: (_, { pid }) => saveConfig({ projects: state.config.projects.map((p) => p.id === pid ? { ...p, hidden: !p.hidden } : p) }),
  open: (b) => api('POST', '/api/open', { path: b.dataset.path, with: b.dataset.with }),
  'open-wt': (_, { pid }) => api('POST', '/api/open-wt', { projectId: pid }),
  view: (b) => { state.view = b.dataset.view as 'tabs' | 'grid'; persist(); render(); },
  'toggle-hidden': () => { state.showHidden = !state.showHidden; render(); },
  rescan: async () => { state.config = await api('POST', '/api/scan'); render(); },
  theme: () => { nextTheme(); render(); },
  notify: () => toggleNotify(),
  palette: () => openPalette(),
  import: (b) => openImport(b.dataset.kind as 'project' | 'root'),
  'remove-folder': (b) => saveConfig(b.dataset.kind === 'root' ? { roots: state.config.roots.filter((r) => r !== b.dataset.path) } : { manual: state.config.manual.filter((r) => r !== b.dataset.path) }),
  browse: async (b) => {
    (b as HTMLButtonElement).disabled = true;
    try {
      const { path } = await api('POST', '/api/pick-folder');
      if (path) { $<HTMLInputElement>('#import-path').value = path; form('#import-form').requestSubmit(); }
    } finally { (b as HTMLButtonElement).disabled = false; }
  },
  'close-dialog': () => $<HTMLDialogElement>('#import-dialog').close(),
  // requirements
  'req-refresh': () => loadRequirements(state.selected!, true),
  'req-fix': async (b) => {
    const pid = state.selected!;
    const { kind, arg } = b.dataset;
    if (kind === 'install') { send({ t: 'install', appId: arg! }); toast('Installing dependencies. Output is in the new tab.'); }
    else if (kind === 'service') { send({ t: 'startService', serviceId: arg! }); toast('Starting service...'); setTimeout(() => loadRequirements(pid, true), 4000); }
    else { toast((await api('POST', '/api/requirements/fix', { projectId: pid, kind, arg })).message); state.config = await api('GET', '/api/config'); }
    loadRequirements(pid, true);
  },
  // services
  'start-service': (_, { sid }) => send({ t: 'startService', serviceId: sid! }),
  'stop-service': (_, { sid }) => send({ t: 'stopService', serviceId: sid! }),
  'edit-service': (_, { sid }) => openServiceDialog(state.config.services.find((x) => x.id === sid)),
  'remove-service': async (_, { sid }) => {
    const svc = state.config.services.find((x) => x.id === sid);
    if (svc && confirm(`Remove "${svc.name}"? A running instance is stopped.`)) { state.config = await api('POST', '/api/services/remove', { id: sid }); render(); }
  },
  'detect-xampp': async () => { state.config = await api('POST', '/api/services/detect-xampp', {}); render(); },
  'close-service': () => $<HTMLDialogElement>('#service-dialog').close(),
  log: (b) => openLog(b.dataset.file!),
  'log-refresh': () => loadLog(),
  'close-log': () => $<HTMLDialogElement>('#log-dialog').close(),
  docker: (b) => send({ t: 'docker', action: b.dataset.action as 'start' | 'stop' | 'restart', id: dataOf(b, 'cid')! }),
  'docker-logs': (b) => {
    const c = state.docker.containers.find((x) => x.ID === dataOf(b, 'cid'));
    if (c) openLog({ docker: c.ID, title: c.Names, sub: c.Image });
  },
  // databases
  'db-refresh': () => loadDb(true),
  'db-folder': () => api('POST', '/api/db/open-folder'),
  'db-backup': (b) => dbAction(`Backing up ${b.dataset.db}`, '/api/db/backup', { name: b.dataset.db }, (r) => toast(`Saved ${r.file}`)),
  'db-restore': (b) => {
    if (confirm(`Restore "${b.dataset.db}" from ${b.dataset.file}?\n\nThe current database is backed up automatically first.`)) {
      return dbAction(`Restoring ${b.dataset.db}`, '/api/db/restore', { file: b.dataset.file }, (r) => toast(r.safety ? `Restored. Previous state saved as ${r.safety}` : 'Restored.'));
    }
  },
  'db-delete': (b) => { if (confirm(`Delete ${b.dataset.file}? This cannot be undone.`)) return dbAction('Deleting', '/api/db/delete-backup', { file: b.dataset.file }); },
  'db-creds': async () => {
    const user = prompt('MySQL user', state.config.mysql?.user || 'root');
    if (user === null) return;
    const password = prompt(`Password for ${user} (empty for XAMPP's default root)`, '');
    if (password === null) return;
    await api('POST', '/api/db/credentials', { user, password });
    loadDb(true);
  },
  'backup-schedule-save': async () => {
    const f = form('#backup-form');
    await api('POST', '/api/db/schedule', { enabled: field(f, 'enabled').checked, everyHours: field(f, 'everyHours').value, keep: field(f, 'keep').value, beforePull: field(f, 'beforePull').checked });
    toast('Backup schedule saved.');
    loadDb(true);
  },
  // git
  'git-file': (b) => gitSelect({ file: b.dataset.file }),
  'git-commit-show': (b) => gitSelect({ commit: b.dataset.hash }),
  'git-refresh': () => loadGit(state.gitView!.projectId, { keep: true }),
  'git-remote': (b) => gitRun('/api/git/remote', { action: b.dataset.action }),
  'git-commit': () => gitCommit(),
  // env
  'env-file': (b) => { state.envView!.file = b.dataset.file!; state.envView!.editing = false; loadEnv(); },
  'env-reveal': () => { state.envView!.reveal = !state.envView!.reveal; drawEnv(); },
  'env-edit': () => { state.envView!.editing = true; drawEnv(); $('#env-text').focus(); },
  'env-cancel': () => { state.envView!.editing = false; drawEnv(); },
  'env-save': () => saveEnv(),
  // settings + accounts
  settings: () => openSettings(),
  'close-settings': () => $<HTMLDialogElement>('#settings').close(),
  logout: async () => { await api('POST', '/api/logout'); location.href = '/login.html'; },
  'autostart-toggle': async () => { await api('POST', '/api/autostart', { enabled: !state.me.autostart }); await loadSettings(); },
  shortcut: async () => toast(`Shortcut created: ${(await api('POST', '/api/shortcut')).path}`),
  'user-create': async () => {
    const f = form('#user-form');
    await api('POST', '/api/users/create', { username: field(f, 'username').value, password: field(f, 'password').value });
    f.reset();
    await loadSettings();
  },
  'user-delete': async (b) => { if (confirm(`Delete account "${b.dataset.name}"? Its devices are signed out.`)) { await api('POST', '/api/users/delete', { id: b.dataset.uid }); await loadSettings(); } },
  'user-password': async (b) => {
    const password = prompt(`New password for ${b.dataset.name} (min. 8 characters). All its devices get signed out.`);
    if (!password) return;
    await api('POST', '/api/users/password', { id: b.dataset.uid, password });
    toast('Password changed.');
    if (Number(b.dataset.uid) === state.me.userId) location.href = '/login.html'; else await loadSettings();
  },
  'mfa-start': async (b) => {
    const r = await api('POST', '/api/users/mfa/start', { id: b.dataset.uid });
    state.settings.mfa = { uid: b.dataset.uid!, name: b.dataset.name!, ...r };
    drawSettings();
    $('#mfa-code').focus();
  },
  'mfa-confirm': async () => {
    await api('POST', '/api/users/mfa/confirm', { id: state.settings.mfa!.uid, code: $<HTMLInputElement>('#mfa-code').value });
    state.settings.mfa = null;
    toast('Two-factor authentication is on.');
    await loadSettings();
  },
  'mfa-cancel': () => { state.settings.mfa = null; drawSettings(); },
  'mfa-disable': async (b) => {
    const code = state.me.local ? '' : prompt('Enter a current code from your authenticator app to turn MFA off.');
    if (code === null || (state.me.local && !confirm(`Turn off two-factor for ${b.dataset.name}?`))) return;
    await api('POST', '/api/users/mfa/disable', { id: b.dataset.uid, code });
    await loadSettings();
  },
  'session-revoke': async (b) => { await api('POST', '/api/sessions/revoke', { id: b.dataset.sid }); if (b.dataset.current) location.href = '/login.html'; else await loadSettings(); },
};

document.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  const btn = target.closest<HTMLElement>('[data-act]');
  if (!btn || target.closest('a') || target.matches('input[type=checkbox]')) return;
  e.stopPropagation();
  const ids = { pid: dataOf(btn, 'pid'), aid: dataOf(btn, 'aid'), tid: dataOf(btn, 'tid'), sid: dataOf(btn, 'sid') };
  try { await actions[btn.dataset.act!]?.(btn, ids); } catch (err) { toast((err as Error).message, true); }
});

// Checkboxes: project settings ("start with Devdeck", "needs MySQL") and git file selection.
document.addEventListener('change', async (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.projSetting || el.dataset.projService) {
    const p = state.config.projects.find((x) => x.id === state.selected);
    if (!p) return;
    const svc = el.dataset.projService;
    const patch = el.dataset.projSetting ? { [el.dataset.projSetting]: el.checked }
      : { services: el.checked ? [...new Set([...(p.services || []), svc!])] : (p.services || []).filter((id) => id !== svc) };
    await saveConfig({ projects: state.config.projects.map((x) => x.id === p.id ? { ...x, ...patch } : x) });
    loadRequirements(p.id, true);
    return;
  }
  const v = state.gitView;
  if (!v?.data) return;
  if (el.id === 'git-all') v.unchecked = el.checked ? new Set() : new Set(v.data.files.map((f) => f.path));
  else if (el.dataset.check) {
    v.unchecked ??= new Set();
    if (el.checked) v.unchecked.delete(el.dataset.check); else v.unchecked.add(el.dataset.check);
  } else return;
  v.checked = new Set(v.data.files.map((f) => f.path).filter((p) => !v.unchecked!.has(p)));
  drawGit();
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'k') { e.preventDefault(); openPalette(); }
  if ((e.target as HTMLElement).id === 'git-msg' && e.ctrlKey && e.key === 'Enter') gitCommit();
});

// ---------- forms and dialogs ----------
form('#import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target as HTMLFormElement);
  const kind = String(f.get('kind'));
  const path = String(f.get('path')).trim().replace(/^"|"$/g, '');
  try {
    state.config = await api('POST', '/api/folders', { path, kind });
    $<HTMLDialogElement>('#import-dialog').close();
    const norm = (s: string) => s.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
    state.selected = kind === 'project' ? state.config.projects.find((p) => norm(p.path) === norm(path))?.id ?? state.selected : null;
    persist();
    render();
  } catch (err) { $('#import-error').textContent = (err as Error).message; }
});
form('#service-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  try {
    state.config = await api('POST', '/api/services', { ...Object.fromEntries(new FormData(f)), autostart: field(f, 'autostart').checked });
    $<HTMLDialogElement>('#service-dialog').close();
    state.selected = SERVICES;
    persist();
    render();
  } catch (err) { $('#service-error').textContent = (err as Error).message; }
});
$('#log-dialog').addEventListener('close', stopLogFollow);
$('#palette-input').addEventListener('input', filterPalette);
$('#palette-input').addEventListener('keydown', paletteKey);
$('#palette-list').addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
  if (el) runPalette(Number(el.dataset.index));
});
$('#palette').addEventListener('click', (e) => { if ((e.target as HTMLElement).id === 'palette') $<HTMLDialogElement>('#palette').close(); });
$('#search').addEventListener('input', (e) => { state.query = (e.target as HTMLInputElement).value; render(); });
$('#page').addEventListener('pointermove', chartHover);
$('#page').addEventListener('pointerleave', chartHover);
new ResizeObserver(queueFit).observe($('#stage'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());

// Live uptime counters, without re-rendering anything.
setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>('[data-since]')) el.textContent = fmtDur(now - Number(el.dataset.since));
}, 1000);

// ---------- boot ----------
// Load the mono font before xterm measures cell size, otherwise columns come out wrong.
await document.fonts.load('13px "Geist Mono Variable"').catch(() => {});
applyTheme();
renderNotify();
state.me = await api('GET', '/api/me');
document.body.classList.toggle('remote', !state.me.local);
$('#logout-btn').hidden = !state.me.user;
state.config = await api('GET', '/api/config');
state.history = await api<History>('GET', '/api/stats/history').catch(() => state.history);
render();
connect(onMessage);
