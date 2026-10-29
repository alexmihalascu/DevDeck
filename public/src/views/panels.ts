// Interactive panels that own inputs (git, env, settings), dialogs, the command palette, theme and notifications.
import type { GitFile, Project, Service, TermMeta } from '../../../types.ts';
import { $, esc, ago, toast, store, morph, hue } from '../util.ts';
import { api, send } from '../net.ts';
import { state, persist, SERVICES, projectOf, serviceState, emptyState, skeletonRows } from '../state.ts';
import { render } from '../render.ts';
import { focusTerm, runScript, xtermTheme } from '../terminals.ts';

const input = (sel: string) => $<HTMLInputElement>(sel);

// ---------- theme ----------
const THEMES = ['system', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];
const THEME_ICON: Record<Theme, string> = { system: 'ph-circle-half', light: 'ph-sun', dark: 'ph-moon' };
export function applyTheme(theme: Theme = store.get<Theme>('theme', 'system')) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  store.set('theme', theme);
  $('#theme-btn').innerHTML = `<i class="ph ${THEME_ICON[theme]}"></i>`;
  $('#theme-btn').title = `Theme: ${theme} (click to change)`;
  for (const t of state.terms.values()) t.term.options.theme = xtermTheme();
}
export const nextTheme = () => applyTheme(THEMES[(THEMES.indexOf(store.get<Theme>('theme', 'system')) + 1) % 3]);

// ---------- crash notifications ----------
export function crashed(m: TermMeta) {
  const where = projectOf(m.projectId)?.name;
  const text = m.conflict ? `Port ${m.conflict} is already in use` : `Exited with code ${m.code}`;
  toast(`${where} / ${m.title}: ${text}`, true);
  if (state.notify && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    const n = new Notification(`${m.title} crashed`, { body: `${where}. ${text}`, tag: m.id });
    n.onclick = () => { window.focus(); focusTerm(m); };
  }
}
export async function toggleNotify() {
  // Browsers only allow system notifications on https or localhost; from another PC the in-page toast still works.
  if (!state.notify && !window.isSecureContext) return toast('Windows notifications need localhost or https. Crash messages still pop up inside Devdeck.', true);
  if (!state.notify && 'Notification' in window && Notification.permission !== 'granted') {
    if (await Notification.requestPermission() !== 'granted') return toast('Notifications are blocked in the browser settings.', true);
  }
  state.notify = !state.notify;
  store.set('notify', state.notify);
  renderNotify();
  toast(state.notify ? 'You get a Windows notification when something crashes.' : 'Crash notifications off.');
}
/** The switch lives in Settings; redraw it there if Settings is open. */
export function renderNotify() {
  if ($<HTMLDialogElement>('#settings').open) drawSettings();
}

// ---------- ask: the app's own confirm / prompt ----------
export interface AskField { name: string; label: string; type?: 'text' | 'password'; value?: string; placeholder?: string; hint?: string; numeric?: boolean; min?: number }
export interface AskOptions { title: string; text?: string; fields?: AskField[]; ok?: string; danger?: boolean }
let askDone: ((v: Record<string, string> | null) => void) | null = null;
/** Resolves with the field values, or null when cancelled. Passwords are typed into real password inputs, never prompt(). */
export function ask(o: AskOptions): Promise<Record<string, string> | null> {
  askDone?.(null);
  const dlg = $<HTMLDialogElement>('#ask');
  $('#ask-title').textContent = o.title;
  $('#ask-text').textContent = o.text || '';
  $('#ask-text').hidden = !o.text;
  $('#ask-error').textContent = '';
  $('#ask-fields').innerHTML = (o.fields || []).map((f, i) => `<div class="ask-field">
    <label for="ask-${i}">${esc(f.label)}</label>
    <input id="ask-${i}" name="${esc(f.name)}" class="field${f.numeric || f.type === 'password' ? ' mono' : ''}" type="${f.type || 'text'}" value="${esc(f.value || '')}"
      placeholder="${esc(f.placeholder || '')}" autocomplete="${f.type === 'password' ? 'new-password' : 'off'}" spellcheck="false"
      ${f.numeric ? 'inputmode="numeric" maxlength="6"' : ''} ${f.min ? `minlength="${f.min}" required` : ''}>
    ${f.hint ? `<span class="muted small">${esc(f.hint)}</span>` : ''}</div>`).join('');
  const ok = $<HTMLButtonElement>('#ask-ok');
  ok.textContent = o.ok || 'OK';
  ok.classList.toggle('danger', !!o.danger);
  dlg.showModal();
  ($<HTMLInputElement>('#ask-fields input') || ok).focus();
  return new Promise((resolve) => { askDone = (v) => { askDone = null; resolve(v); }; });
}
export function initAsk() {
  const dlg = $<HTMLDialogElement>('#ask');
  $('#ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const values = Object.fromEntries([...new FormData(e.target as HTMLFormElement)].map(([k, v]) => [k, String(v)]));
    const done = askDone;
    askDone = null;
    dlg.close();
    done?.(values);
  });
  $('#ask-cancel').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => askDone?.(null));
}

// ---------- import + service dialogs ----------
export function openImport(kind: 'project' | 'root') {
  $('#import-title').textContent = kind === 'project' ? 'Import project' : 'Add workspace folder';
  $('#import-help').textContent = kind === 'project'
    ? 'A project folder. Every package.json inside it (root, backend/, frontend/, packages/*) shows up as a runnable app.'
    : 'A folder that holds many projects, like Desktop\\code. Each subfolder becomes a project, and new ones appear on rescan.';
  $('#import-error').textContent = '';
  $<HTMLFormElement>('#import-form').reset();
  input('#import-kind').value = kind;
  $<HTMLDialogElement>('#import-dialog').showModal();
}
export function openServiceDialog(svc?: Service) {
  const f = $<HTMLFormElement>('#service-form');
  f.reset();
  const el = (k: string) => f.elements.namedItem(k) as HTMLInputElement;
  for (const k of ['id', 'name', 'cmd', 'stopCmd', 'cwd', 'port', 'url'] as const) el(k).value = String(svc?.[k] ?? '');
  el('autostart').checked = !!svc?.autostart;
  el('logs').value = (svc?.logs || []).join('\n');
  $('#service-title').textContent = svc ? `Edit ${svc.name}` : 'Add service';
  $('#service-error').textContent = '';
  $<HTMLDialogElement>('#service-dialog').showModal();
}

// ---------- log viewer (files and docker containers) ----------
type LogSource = string | { docker: string; title: string; sub: string };
let logSource: LogSource | null = null;
let logTimer: number | undefined;
export async function loadLog() {
  const pre = $('#log-body');
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  try {
    const r = typeof logSource === 'object' && logSource
      ? await api('POST', '/api/docker/logs', { id: logSource.docker })
      : await api('POST', '/api/log', { path: logSource });
    $('#log-meta').textContent = r.missing ? 'File does not exist yet. It appears once the service writes to it.'
      : `${(r.size / 1024).toFixed(1)} KB, updated ${new Date(r.mtime).toLocaleTimeString()}${r.truncated ? ', showing the last 96 KB' : ''}`;
    pre.textContent = r.text || '';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch (err) { $('#log-meta').textContent = (err as Error).message; }
}
export async function openLog(src: LogSource) {
  logSource = src;
  $('#log-title').textContent = typeof src === 'object' ? src.title : src.split(/[\\/]/).pop() || src;
  $('#log-path').textContent = typeof src === 'object' ? src.sub : src;
  $('#log-body').textContent = '';
  $<HTMLDialogElement>('#log-dialog').showModal();
  await loadLog();
  $('#log-body').scrollTop = $('#log-body').scrollHeight;
  clearInterval(logTimer);
  logTimer = window.setInterval(() => { if (input('#log-follow').checked) loadLog(); }, 2000);
}
export const stopLogFollow = () => clearInterval(logTimer);

// ---------- git ----------
const statusCode = (f: GitFile) => f.untracked ? 'new' : (f.x !== ' ' ? f.x : f.y);
export async function loadGit(projectId: string, { keep = false } = {}) {
  const prev = state.gitView?.projectId === projectId && keep ? state.gitView : null;
  const v = state.gitView = prev || { projectId, data: null, file: null, commit: null, diff: '', checked: new Set<string>(), output: '', message: '' };
  if (!prev) drawGit();
  try {
    v.data = await api('POST', '/api/git/status', { projectId });
    v.error = null;
    const paths = v.data!.files.map((f) => f.path);
    v.checked = new Set(paths.filter((p) => !v.unchecked?.has(p)));
    if (v.file && !paths.includes(v.file)) { v.file = null; v.diff = ''; }
    if (!v.file && !v.commit && paths.length) return gitSelect({ file: paths[0] });
    if (v.file) v.diff = (await api('POST', '/api/git/diff', { projectId, file: v.file })).diff;
  } catch (err) { v.error = (err as Error).message; }
  drawGit();
}
export async function gitSelect({ file, commit }: { file?: string; commit?: string }) {
  const v = state.gitView!;
  Object.assign(v, { file: file || null, commit: commit || null, diffLoading: true });
  drawGit();
  try {
    v.diff = (file ? await api('POST', '/api/git/diff', { projectId: v.projectId, file }) : await api('POST', '/api/git/show', { projectId: v.projectId, hash: commit })).diff;
  } catch (err) { v.diff = (err as Error).message; }
  v.diffLoading = false;
  drawGit();
}
export async function gitRun(url: string, body: Record<string, unknown>) {
  const v = state.gitView!;
  v.busy = true;
  v.output = 'Working...';
  drawGit();
  try { v.output = (await api('POST', url, { projectId: v.projectId, ...body })).output; v.ok = true; } catch (err) { v.output = (err as Error).message; v.ok = false; }
  v.busy = false;
  await loadGit(v.projectId, { keep: true });
}
export function gitCommit() {
  const v = state.gitView!;
  const files = v.data!.files.map((f) => f.path).filter((p) => v.checked.has(p));
  if (!files.length) return toast('Select at least one file.', true);
  v.message = $<HTMLTextAreaElement>('#git-msg').value;
  gitRun('/api/git/commit', { message: v.message, files }).then(() => { if (v.ok) { v.message = ''; drawGit(); } });
}
function renderDiff(text: string) {
  const lines = text.split('\n');
  return lines.slice(0, 6000).map((l) => {
    const cls = /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l) ? 'meta'
      : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
    return `<div class="dl ${cls}">${esc(l) || ' '}</div>`;
  }).join('') + (lines.length > 6000 ? '<div class="dl meta">Diff truncated at 6000 lines.</div>' : '');
}
export function drawGit() {
  const v = state.gitView;
  const page = $('#page');
  if (!v || page.dataset.view !== `git:${v.projectId}`) return;
  const msg = $<HTMLTextAreaElement>('#git-msg')?.value ?? v.message;
  const focused = document.activeElement?.id === 'git-msg';
  if (!v.data && !v.error) { page.innerHTML = `<div class="page-inner" aria-busy="true"><div class="list">${skeletonRows(6)}</div></div>`; return; }
  if (!v.data) { page.innerHTML = `<div class="page-inner">${emptyState('ph-git-branch', 'No git here', esc(v.error))}</div>`; return; }
  const d = v.data;
  const busy = v.busy ? 'disabled' : '';
  page.innerHTML = `<div class="git">
    <div class="git-bar">
      <span class="tag"><i class="ph ph-git-branch"></i>${esc(d.branch || 'detached')}</span>
      ${d.upstream ? `<span class="muted mono small">${esc(d.upstream)}</span>` : '<span class="muted small">no upstream</span>'}
      ${d.ahead ? `<span class="tag ok">${d.ahead} ahead</span>` : ''}${d.behind ? `<span class="tag warn">${d.behind} behind</span>` : ''}
      <span class="git-out ${v.ok === false ? 'err' : ''}" title="${esc(v.output)}">${esc(v.output?.split('\n').filter(Boolean).pop() || '')}</span>
      <button class="btn sm" data-act="git-refresh" ${busy}><i class="ph ph-arrow-clockwise"></i>Refresh</button>
      <button class="btn sm" data-act="git-remote" data-action="fetch" ${busy}><i class="ph ph-cloud-arrow-down"></i>Fetch</button>
      <button class="btn sm" data-act="git-remote" data-action="pull" ${busy}><i class="ph ph-arrow-down"></i>Pull</button>
      <button class="btn sm" data-act="git-remote" data-action="push" ${busy}><i class="ph ph-arrow-up"></i>Push${d.ahead ? ` ${d.ahead}` : ''}</button>
    </div>
    <div class="git-body">
      <aside class="git-side">
        <div class="git-commit">
          <textarea id="git-msg" class="field" rows="3" placeholder="Commit message (Ctrl+Enter)"></textarea>
          <button class="btn btn-primary" data-act="git-commit" ${v.busy || !d.files.length ? 'disabled' : ''}><i class="ph ph-check"></i>Commit ${v.checked.size} of ${d.files.length}</button>
        </div>
        <div class="git-head"><label><input type="checkbox" id="git-all" ${d.files.length && d.files.every((f) => v.checked.has(f.path)) ? 'checked' : ''}> Changes</label><span class="muted">${d.files.length}</span></div>
        <div class="git-files">${d.files.map((f) => {
          const code = statusCode(f);
          const slash = f.path.lastIndexOf('/');
          return `<div class="git-file${v.file === f.path ? ' active' : ''}" tabindex="0" data-act="git-file" data-file="${esc(f.path)}">
            <input type="checkbox" data-check="${esc(f.path)}" ${v.checked.has(f.path) ? 'checked' : ''} aria-label="Include ${esc(f.path)}">
            <span class="fname">${esc(f.path.slice(slash + 1))}</span><span class="fdir">${esc(f.path.slice(0, slash + 1))}</span>
            <span class="st st-${code === 'new' ? 'A' : esc(code)}">${code === 'new' ? 'U' : esc(code)}</span>
          </div>`;
        }).join('') || '<p class="muted small pad">Working tree clean.</p>'}</div>
        <div class="git-head"><span>History</span></div>
        <div class="git-log">${d.log.map((c) => `
          <div class="git-commit-row${v.commit === c.hash ? ' active' : ''}" tabindex="0" data-act="git-commit-show" data-hash="${c.hash}">
            <div class="subject">${esc(c.subject)}</div>
            <div class="muted small">${esc(c.short)} · ${esc(c.author)} · ${ago(c.at)}${c.refs ? ` <span class="refs">${esc(c.refs.replace('HEAD -> ', ''))}</span>` : ''}</div>
          </div>`).join('') || '<p class="muted small pad">No commits yet.</p>'}</div>
      </aside>
      <section class="git-diff">
        <div class="diff-head mono">${esc(v.file || (v.commit ? `commit ${v.commit.slice(0, 10)}` : ''))}</div>
        <div class="diff-body">${v.diffLoading ? '<div class="dl meta">Loading...</div>' : v.diff ? renderDiff(v.diff) : '<div class="dl meta">Select a file or a commit.</div>'}</div>
      </section>
    </div>
  </div>`;
  const ta = $<HTMLTextAreaElement>('#git-msg');
  ta.value = msg;
  if (focused) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

// ---------- env files ----------
export function openEnv(p: Project) {
  const prev = state.envView;
  state.envView = { projectId: p.id, file: prev?.projectId === p.id && p.envFiles.includes(prev.file) ? prev.file : p.envFiles.find((f) => /\.env$/.test(f)) || p.envFiles[0], text: '', reveal: false, editing: false };
  loadEnv();
}
export async function loadEnv() {
  const v = state.envView!;
  try { v.text = (await api('POST', '/api/env/read', { file: v.file })).text; v.error = null; } catch (err) { v.error = (err as Error).message; }
  drawEnv();
}
export async function saveEnv() {
  const v = state.envView!;
  const text = $<HTMLTextAreaElement>('#env-text').value;
  try {
    await api('POST', '/api/env/write', { file: v.file, text });
    Object.assign(v, { text, editing: false });
    toast('Saved. The previous version is kept in data/env-backups.');
    drawEnv();
  } catch (err) { toast((err as Error).message, true); }
}
const SECRET_RE = /pass|secret|token|key|private|auth|credential|dsn|url/i;
export function drawEnv() {
  const v = state.envView;
  const page = $('#page');
  const p = v && projectOf(v.projectId);
  if (!v || !p || page.dataset.view !== `env:${v.projectId}`) return;
  const rel = (f: string) => f.slice(p.path.length + 1).replaceAll('\\', '/');
  const rows = v.text.split(/\r?\n/).map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
    if (!m) return line.trim() ? `<div class="env-row comment">${esc(line)}</div>` : '';
    const secret = SECRET_RE.test(m[1]) && m[2].trim();
    const value = v.reveal || !secret ? esc(m[2]) : '<span class="masked">••••••••</span>';
    return `<div class="env-row"><span class="env-key">${esc(m[1])}</span><span class="env-val">${value || '<span class="muted">empty</span>'}</span></div>`;
  }).join('');
  page.innerHTML = `<div class="page-inner">
    <div class="env-files">${p.envFiles.map((f) => `<button class="btn sm${f === v.file ? ' on' : ''}" data-act="env-file" data-file="${esc(f)}">${esc(rel(f))}</button>`).join('')}</div>
    <section class="app-block">
      <div class="app-top"><i class="ph ph-key muted"></i><h3 class="mono">${esc(rel(v.file))}</h3>
        <div class="actions">${v.editing
          ? '<button class="btn sm" data-act="env-cancel">Cancel</button><button class="btn sm btn-primary" data-act="env-save"><i class="ph ph-check"></i>Save</button>'
          : `<button class="btn sm" data-act="env-reveal"><i class="ph ${v.reveal ? 'ph-eye-slash' : 'ph-eye'}"></i>${v.reveal ? 'Hide' : 'Reveal'} secrets</button>
             <button class="btn sm" data-act="env-edit"><i class="ph ph-pencil-simple"></i>Edit</button>`}</div>
      </div>
      ${v.error ? `<p class="pad form-error">${esc(v.error)}</p>` : v.editing ? '<textarea id="env-text" class="env-edit mono" spellcheck="false"></textarea>'
        : `<div class="env-table">${rows || '<p class="muted pad">Empty file.</p>'}</div>`}
    </section>
  </div>`;
  if (v.editing) $<HTMLTextAreaElement>('#env-text').value = v.text;
}

// ---------- settings (section nav with search, grouped rows) ----------
type SettingsSection = 'general' | 'network' | 'accounts' | 'devices';
const SECTIONS: { id: SettingsSection; label: string; icon: string; group: string }[] = [
  { id: 'general', label: 'General', icon: 'ph-sliders-horizontal', group: 'Devdeck' },
  { id: 'network', label: 'Network', icon: 'ph-wifi-high', group: 'Devdeck' },
  { id: 'accounts', label: 'Accounts', icon: 'ph-users', group: 'Security' },
  { id: 'devices', label: 'Devices', icon: 'ph-devices', group: 'Security' },
];
/** Every searchable row. Titles and descriptions live here once; rows read them from here. */
const ITEMS: { id: string; section: SettingsSection; title: string; desc: string; local?: boolean }[] = [
  { id: 'theme', section: 'general', title: 'Theme', desc: 'Follow Windows, or stay light or dark.' },
  { id: 'notify', section: 'general', title: 'Crash notifications', desc: 'A Windows notification when a script or service crashes while Devdeck is in the background.' },
  { id: 'autostart', section: 'general', title: 'Start Devdeck with Windows', desc: 'Runs in the background after you sign in to Windows, no window. Projects and services set to auto-start come up with it.', local: true },
  { id: 'shortcut', section: 'general', title: 'Desktop shortcut', desc: "Starts Devdeck if it isn't running and opens it in the browser.", local: true },
  { id: 'urls', section: 'network', title: 'Addresses on your network', desc: 'Open one of these on another PC or phone and sign in.' },
  { id: 'http', section: 'network', title: 'Plain HTTP', desc: 'Traffic is not encrypted, so use network access only on a network you trust.' },
  { id: 'users', section: 'accounts', title: 'Accounts', desc: 'Who can sign in, their passwords, and who can be deleted.' },
  { id: 'two-factor', section: 'accounts', title: 'Two-factor authentication', desc: '2FA / MFA: a 6-digit code from an authenticator app on every sign-in, on top of the password.' },
  { id: 'new-user', section: 'accounts', title: 'Add an account', desc: 'A user name and a password of at least 8 characters.', local: true },
  { id: 'reset', section: 'accounts', title: 'Locked out', desc: 'Lost your phone or password? Run npm run reset -- <user> <new password> in the Devdeck folder on this PC.', local: true },
  { id: 'sessions', section: 'devices', title: 'Signed-in devices', desc: 'Every browser that is signed in. Signing one out ends its session right away.' },
];
const item = (id: string) => ITEMS.find((i) => i.id === id)!;

export async function openSettings(section?: SettingsSection) {
  state.settings.mfa = null;
  if (section) store.set('settingsSection', section);
  input('#settings-search').value = '';
  $<HTMLDialogElement>('#settings').showModal();
  drawSettings();
  await loadSettings();
}
export async function loadSettings() {
  try {
    state.me = await api('GET', '/api/me');
    Object.assign(state.settings, await api('GET', '/api/users'), { error: '' });
  } catch (err) { state.settings.error = (err as Error).message; }
  drawSettings();
}
export function settingsGo(section: SettingsSection, rowId?: string) {
  store.set('settingsSection', section);
  // Account-wide entries point at the signed-in user's own row.
  if (rowId === 'users' || rowId === 'two-factor') rowId = `user-${state.me.userId}`;
  input('#settings-search').value = '';
  drawSettings(true);
  const row = rowId && document.querySelector<HTMLElement>(`#settings-body [data-row="${rowId}"]`);
  if (row) {
    row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    row.classList.remove('pulse');
    void row.offsetWidth;
    row.classList.add('pulse');
  }
}
const device = (a = '') => /Windows/.test(a) ? 'Windows' : /Android/.test(a) ? 'Android' : /iPhone|iPad/.test(a) ? 'iOS' : /Mac/.test(a) ? 'macOS' : /Linux/.test(a) ? 'Linux' : 'Browser';
const browser = (a = '') => /Edg\//.test(a) ? 'Edge' : /Chrome\//.test(a) ? 'Chrome' : /Firefox\//.test(a) ? 'Firefox' : /Safari\//.test(a) ? 'Safari' : '';
const deviceIcon = (a = '') => /Android|iPhone|iPad/.test(a) ? 'ph-device-mobile' : 'ph-desktop';

/** Row: title and description on the left, the control on the right (stacks on narrow screens). */
const row = (id: string, control: string, extra: { title?: string; desc?: string; body?: string } = {}) => {
  const i = ITEMS.find((x) => x.id === id);
  const title = extra.title ?? esc(i?.title), desc = extra.desc ?? esc(i?.desc || '');
  return `<div class="set-row" data-row="${esc(id)}">
    <div class="set-text"><h3>${title}</h3>${desc ? `<p>${desc}</p>` : ''}</div>
    <div class="set-ctl">${control}</div>${extra.body ? `<div class="set-body">${extra.body}</div>` : ''}</div>`;
};
const group = (title: string, rows: string, action = '') => rows.trim() ? `<section class="set-section">
  <div class="set-section-head"><h2>${title}</h2>${action}</div><div class="set-group">${rows}</div></section>` : '';
const switchCtl = (on: boolean, act: string, label: string) => `<button class="switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-act="${act}"></button>`;

function settingsPage(section: SettingsSection): string {
  const { me, settings: s } = state;
  if (section === 'general') {
    const theme = store.get<string>('theme', 'system');
    const opt = (t: string, icon: string, label: string) => `<button aria-pressed="${theme === t}" data-act="set-theme" data-theme="${t}"><i class="ph ${icon}"></i>${label}</button>`;
    return group('Appearance', row('theme', `<div class="seg-ctl" role="group" aria-label="Theme">${opt('system', 'ph-monitor', 'System')}${opt('light', 'ph-sun', 'Light')}${opt('dark', 'ph-moon', 'Dark')}</div>`))
      + group('Notifications', row('notify', switchCtl(state.notify, 'notify', 'Crash notifications')))
      + (me.local ? group('This PC', row('autostart', switchCtl(!!me.autostart, 'autostart-toggle', 'Start Devdeck with Windows'))
        + row('shortcut', '<button class="btn sm" data-act="shortcut"><i class="ph ph-desktop"></i>Create</button>')) : '');
  }
  if (section === 'network') {
    const urls = me.urls || [];
    return group('Access from other PCs', row('urls', '', { body: urls.length
      ? `<div class="url-rows">${urls.map((u) => `<div class="url-row"><code>${esc(u)}</code><button class="icon-btn sm" data-act="copy" data-text="${esc(u)}" title="Copy address"><i class="ph ph-copy"></i></button></div>`).join('')}</div>`
      : '<p class="muted small">No network address found. Is this PC on a network?</p>' })
      + row('http', '', { title: `<i class="ph-fill ph-warning warn-ink"></i>${esc(item('http').title)}` }));
  }
  if (section === 'accounts') {
    const mfa = s.mfa;
    const users = s.users.map((u) => row(`user-${u.id}`, `
      ${u.totp_enabled ? `<button class="btn sm" data-act="mfa-disable" data-uid="${u.id}" data-name="${esc(u.username)}">Turn off 2FA</button>`
        : `<button class="btn sm" data-act="mfa-start" data-uid="${u.id}" data-name="${esc(u.username)}"><i class="ph ph-shield-check"></i>Set up 2FA</button>`}
      <button class="btn sm" data-act="user-password" data-uid="${u.id}" data-name="${esc(u.username)}"><i class="ph ph-key"></i>Password</button>
      ${me.local && u.id !== me.userId ? `<button class="icon-btn" data-act="user-delete" data-uid="${u.id}" data-name="${esc(u.username)}" title="Delete account"><i class="ph ph-trash"></i></button>` : ''}`, {
      title: `<span class="set-avatar" style="--h:${hue(u.username)}">${esc(u.username[0]?.toUpperCase())}</span>${esc(u.username)}${u.id === me.userId ? ' <span class="tag">you</span>' : ''}
        ${u.totp_enabled ? '<span class="tag ok"><i class="ph ph-shield-check"></i>2FA</span>' : '<span class="tag warn">no 2FA</span>'}`,
      desc: `Last sign-in ${ago(u.last_login)}`,
      body: mfa && mfa.uid === String(u.id) ? `<div class="mfa-setup">
        <div class="qr">${mfa.qr}</div>
        <div class="mfa-steps"><p>Scan the code with Google Authenticator, Microsoft Authenticator or 2FAS, then type the 6-digit code it shows.</p>
          <label class="muted small">Or enter this key</label><code class="secret">${esc(mfa.secret.replace(/(.{4})/g, '$1 ').trim())}</code>
          <label class="muted small" for="mfa-code">Code</label>
          <input id="mfa-code" class="field mono" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456">
          <div class="row-actions"><button class="btn sm" data-act="mfa-cancel">Cancel</button><button class="btn sm btn-primary" data-act="mfa-confirm">Turn on</button></div>
        </div></div>` : '',
    })).join('');
    return group(me.local ? 'Accounts' : 'Your account', users)
      + (me.local ? group('New account', row('new-user', '', { body: `<form id="user-form" class="user-form" onsubmit="return false">
          <input name="username" class="field" placeholder="User name" autocomplete="off" aria-label="User name">
          <input name="password" class="field" type="password" placeholder="Password" autocomplete="new-password" aria-label="Password">
          <button class="btn btn-primary" data-act="user-create"><i class="ph ph-user-plus"></i>Add</button></form>` })
        + row('reset', '', { desc: 'Lost your phone or password? On this PC run <code>npm run reset -- &lt;user&gt; &lt;new password&gt;</code> in the Devdeck folder.' })) : '');
  }
  const others = s.sessions.filter((x) => !x.current).length;
  return group('Signed-in devices', s.sessions.map((x) => row(`session-${x.id}`,
    `<button class="btn sm" data-act="session-revoke" data-sid="${esc(x.id)}" ${x.current ? 'data-current="1"' : ''}><i class="ph ph-sign-out"></i>Sign out</button>`, {
    title: `<i class="ph ${deviceIcon(x.agent || '')} muted"></i>${esc(device(x.agent || ''))} ${esc(browser(x.agent || ''))}${x.username ? ` <span class="muted">${esc(x.username)}</span>` : ''}${x.current ? ' <span class="tag ok">this device</span>' : ''}`,
    desc: `<span class="mono">${esc(x.ip?.replace('::ffff:', '') || '')}</span>, active ${ago(x.last_seen)}`,
  })).join('') || row('sessions', '', { desc: 'No devices signed in.' }),
  others ? `<button class="btn sm" data-act="session-revoke-others"><i class="ph ph-sign-out"></i>Sign out ${others} other${others > 1 ? 's' : ''}</button>` : '');
}

/** Redraws nav, breadcrumb and page in place (morph), so typing in the search or a form survives a reload. */
export function drawSettings(scrollTop = false) {
  const { me, settings: s } = state;
  const saved = store.get<string>('settingsSection', 'general');
  const section: SettingsSection = SECTIONS.find((x) => x.id === saved)?.id ?? 'general';
  const q = input('#settings-search').value.trim().toLowerCase();
  const visible = ITEMS.filter((i) => !i.local || me.local);
  // Every typed word has to start a word of the row ("two" finds two-factor, not neTWOrk); title hits first.
  const words = q.split(/\s+/).filter(Boolean);
  const starts = (text: string) => { const t = text.toLowerCase().split(/[^a-z0-9]+/); return words.every((w) => t.some((x) => x.startsWith(w))); };
  const hits = q ? [...visible.filter((i) => starts(i.title)), ...visible.filter((i) => !starts(i.title) && starts(`${i.title} ${i.desc} ${i.section}`))] : [];
  morph($('#settings-nav'), q
    ? hits.map((i, n) => `<button class="set-item result${n === 0 ? ' active' : ''}" data-act="settings-go" data-section="${i.section}" data-row="${i.id}">
        <i class="ph ${SECTIONS.find((x) => x.id === i.section)!.icon}"></i><span><b>${esc(i.title)}</b><small>${esc(SECTIONS.find((x) => x.id === i.section)!.label)}</small></span></button>`).join('')
      || '<p class="set-none">No settings found</p>'
    : [...new Set(SECTIONS.map((x) => x.group))].map((g) => `<div class="set-nav-group"><h4>${g}</h4>
        ${SECTIONS.filter((x) => x.group === g).map((x) => `<button class="set-item${x.id === section ? ' active' : ''}" data-act="settings-go" data-section="${x.id}" ${x.id === section ? 'aria-current="page"' : ''}>
          <i class="ph ${x.icon}"></i><span>${x.label}</span></button>`).join('')}</div>`).join(''));
  morph($('#settings-crumb'), `<span class="muted">Settings</span><i class="ph ph-caret-right faint"></i><span>${SECTIONS.find((x) => x.id === section)!.label}</span>`);
  morph($('#settings-body'), `${s.error ? `<p class="form-error">${esc(s.error)}</p>` : ''}${settingsPage(section)}`);
  if (scrollTop) $('#settings-scroll').scrollTop = 0;
}
export function settingsSearchKey(e: KeyboardEvent) {
  if (e.key === 'Enter') { e.preventDefault(); document.querySelector<HTMLElement>('#settings-nav .result')?.click(); }
  if (e.key === 'Escape' && input('#settings-search').value) { e.preventDefault(); input('#settings-search').value = ''; drawSettings(); }
}

// ---------- command palette ----------
interface PalItem { icon: string; label: string; hint: string; run: () => void }
let palItems: PalItem[] = [], palIndex = 0;
function paletteSource(): PalItem[] {
  const go = (pid: string, page: string) => () => { state.selected = pid; state.active[pid] = page; persist(); render(); };
  const items: PalItem[] = [];
  for (const p of state.config.projects) {
    items.push({ icon: 'ph-folder', label: p.name, hint: 'Open project', run: go(p.id, 'overview') });
    items.push({ icon: 'ph-git-branch', label: `${p.name}: Git`, hint: state.git[p.id]?.changed ? `${state.git[p.id].changed} changed` : 'Git', run: go(p.id, 'git') });
    if (p.apps.some((a) => a.autostart)) items.push({ icon: 'ph-play', label: `${p.name}: Start all`, hint: 'Starred scripts', run: () => { go(p.id, 'overview')(); send({ t: 'startAll', projectId: p.id }); } });
    for (const a of p.apps) for (const s of a.scripts) items.push({ icon: 'ph-terminal', label: `${a.name === p.name ? p.name : `${p.name} / ${a.name}`}: ${s}`, hint: a.cmds?.[s] || '', run: () => runScript(a.id, s) });
  }
  for (const svc of state.config.services) {
    const up = ['running', 'external'].includes(serviceState(svc));
    items.push({ icon: up ? 'ph-stop' : 'ph-play', label: `${up ? 'Stop' : 'Start'} ${svc.name}`, hint: 'Service', run: () => send({ t: up ? 'stopService' : 'startService', serviceId: svc.id }) });
  }
  items.push({ icon: 'ph-database', label: 'Databases and backups', hint: 'Services', run: go(SERVICES, 'overview') });
  items.push({ icon: 'ph-download-simple', label: 'Import project', hint: 'Folder picker', run: () => openImport('project') });
  items.push({ icon: 'ph-circle-half', label: 'Toggle theme', hint: '', run: nextTheme });
  items.push({ icon: 'ph-gear-six', label: 'Settings', hint: 'Theme, network, accounts', run: () => openSettings() });
  items.push({ icon: 'ph-users', label: 'Accounts and two-factor', hint: 'Settings', run: () => openSettings('accounts') });
  items.push({ icon: 'ph-wifi-high', label: 'Open from another PC', hint: 'Settings', run: () => openSettings('network') });
  return items;
}
export function openPalette() {
  input('#palette-input').value = '';
  filterPalette();
  $<HTMLDialogElement>('#palette').showModal();
  input('#palette-input').focus();
}
export function filterPalette() {
  const words = input('#palette-input').value.toLowerCase().split(/\s+/).filter(Boolean);
  palItems = paletteSource().filter((i) => words.every((w) => `${i.label} ${i.hint}`.toLowerCase().includes(w))).slice(0, 60);
  palIndex = 0;
  drawPalette();
}
function drawPalette() {
  $('#palette-list').innerHTML = palItems.map((i, n) => `
    <div class="pal-item${n === palIndex ? ' active' : ''}" data-index="${n}"><i class="ph ${i.icon}"></i><span class="pal-label">${esc(i.label)}</span><span class="pal-hint">${esc(i.hint)}</span></div>`).join('')
    || '<p class="muted pad">Nothing matches.</p>';
  document.querySelector('#palette-list .active')?.scrollIntoView({ block: 'nearest' });
}
export function paletteKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); palIndex = Math.min(palIndex + 1, palItems.length - 1); drawPalette(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); palIndex = Math.max(palIndex - 1, 0); drawPalette(); }
  if (e.key === 'Enter') { e.preventDefault(); runPalette(palIndex); }
}
export function runPalette(n: number) {
  const item = palItems[n];
  $<HTMLDialogElement>('#palette').close();
  item?.run();
}
