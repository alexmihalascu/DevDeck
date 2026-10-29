// Interactive panels that own inputs (git, env, settings), dialogs, the command palette, theme and notifications.
import type { GitFile, Project, Service, TermMeta } from '../../../types.ts';
import { $, esc, ago, toast, store } from '../util.ts';
import { api, send } from '../net.ts';
import { state, persist, SERVICES, projectOf, serviceState } from '../state.ts';
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
export function renderNotify() {
  $('#notify-btn').innerHTML = `<i class="ph ${state.notify ? 'ph-bell-ringing' : 'ph-bell-slash'}"></i>`;
  $('#notify-btn').classList.toggle('on', state.notify);
  $('#notify-btn').title = state.notify ? 'Crash notifications on' : 'Crash notifications off';
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
  if (!v.data && !v.error) { page.innerHTML = '<div class="git-empty muted">Reading repository...</div>'; return; }
  if (!v.data) { page.innerHTML = `<div class="page-inner"><div class="empty-box"><strong>No git here</strong>${esc(v.error)}</div></div>`; return; }
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
          return `<div class="git-file${v.file === f.path ? ' active' : ''}" data-act="git-file" data-file="${esc(f.path)}">
            <input type="checkbox" data-check="${esc(f.path)}" ${v.checked.has(f.path) ? 'checked' : ''} aria-label="Include ${esc(f.path)}">
            <span class="fname">${esc(f.path.slice(slash + 1))}</span><span class="fdir">${esc(f.path.slice(0, slash + 1))}</span>
            <span class="st st-${code === 'new' ? 'A' : esc(code)}">${code === 'new' ? 'U' : esc(code)}</span>
          </div>`;
        }).join('') || '<p class="muted small pad">Working tree clean.</p>'}</div>
        <div class="git-head"><span>History</span></div>
        <div class="git-log">${d.log.map((c) => `
          <div class="git-commit-row${v.commit === c.hash ? ' active' : ''}" data-act="git-commit-show" data-hash="${c.hash}">
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

// ---------- settings ----------
export async function openSettings() {
  state.settings.mfa = null;
  $<HTMLDialogElement>('#settings').showModal();
  await loadSettings();
}
export async function loadSettings() {
  try {
    state.me = await api('GET', '/api/me');
    Object.assign(state.settings, await api('GET', '/api/users'), { error: '' });
  } catch (err) { state.settings.error = (err as Error).message; }
  drawSettings();
}
const device = (a = '') => /Windows/.test(a) ? 'Windows' : /Android/.test(a) ? 'Android' : /iPhone|iPad/.test(a) ? 'iOS' : /Mac/.test(a) ? 'macOS' : /Linux/.test(a) ? 'Linux' : 'Browser';
const browser = (a = '') => /Edg\//.test(a) ? 'Edge' : /Chrome\//.test(a) ? 'Chrome' : /Firefox\//.test(a) ? 'Firefox' : /Safari\//.test(a) ? 'Safari' : '';
export function drawSettings() {
  const { me, settings: s } = state;
  const mfa = s.mfa;
  $('#settings-body').innerHTML = `
    ${s.error ? `<p class="form-error">${esc(s.error)}</p>` : ''}
    ${me.local ? `<section><h3>Devdeck on this PC</h3><div class="list">
      <div class="list-row"><i class="ph ph-power muted"></i>
        <div class="grow"><div>Start Devdeck with Windows</div><div class="sub">Runs in the background after you log in, no window. Projects and services marked to auto-start come up with it.</div></div>
        <button class="btn sm ${me.autostart ? 'btn-primary' : ''}" data-act="autostart-toggle">${me.autostart ? 'On' : 'Off'}</button></div>
      <div class="list-row"><i class="ph ph-desktop muted"></i>
        <div class="grow"><div>Desktop shortcut</div><div class="sub">Starts Devdeck if it isn't running and opens it in the browser.</div></div>
        <button class="btn sm" data-act="shortcut">Create</button></div>
    </div></section>` : ''}
    <section><h3>Access from other PCs</h3>
      <p class="muted">Open one of these on the other PC and sign in:</p>
      <div class="url-list">${me.urls.map((u) => `<code>${esc(u)}</code>`).join('') || '<span class="muted">No network address found.</span>'}</div>
      <p class="muted small">Traffic is plain HTTP, so use it only on a network you trust.</p>
    </section>
    ${mfa ? `<section class="mfa-setup"><h3>Two-factor for ${esc(mfa.name || me.user)}</h3>
      <p class="muted">Scan with Google Authenticator, Microsoft Authenticator or 2FAS, then type the 6-digit code.</p>
      <div class="mfa-grid"><div class="qr">${mfa.qr}</div>
        <div><label class="muted small">Or enter this key</label><code class="secret">${esc(mfa.secret.replace(/(.{4})/g, '$1 ').trim())}</code>
          <label class="muted small" for="mfa-code">Code</label>
          <input id="mfa-code" class="field mono" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
          <div class="row-actions"><button class="btn sm" data-act="mfa-cancel">Cancel</button><button class="btn sm btn-primary" data-act="mfa-confirm">Turn on</button></div>
        </div></div></section>` : ''}
    <section><h3>${me.local ? 'Accounts' : 'Your account'}</h3>
      <div class="list">${s.users.map((u) => `
        <div class="list-row"><i class="ph ph-user-circle muted"></i>
          <div class="grow"><div>${esc(u.username)}${u.id === me.userId ? ' <span class="tag">you</span>' : ''}</div><div class="sub">last sign-in ${ago(u.last_login)}</div></div>
          ${u.totp_enabled ? `<span class="tag ok"><i class="ph ph-shield-check"></i>MFA on</span><button class="btn sm" data-act="mfa-disable" data-uid="${u.id}" data-name="${esc(u.username)}">Turn off</button>`
            : `<span class="tag warn">no MFA</span><button class="btn sm" data-act="mfa-start" data-uid="${u.id}" data-name="${esc(u.username)}"><i class="ph ph-shield-check"></i>Set up MFA</button>`}
          <button class="btn sm" data-act="user-password" data-uid="${u.id}" data-name="${esc(u.username)}">Password</button>
          ${me.local && u.id !== me.userId ? `<button class="icon-btn" data-act="user-delete" data-uid="${u.id}" data-name="${esc(u.username)}" title="Delete account"><i class="ph ph-trash"></i></button>` : ''}
        </div>`).join('')}</div>
      ${me.local ? `<p class="muted small">Lost your phone or password? On this PC run <code>npm run reset -- &lt;user&gt; &lt;new password&gt;</code> in the Devdeck folder.</p>
      <form id="user-form" class="user-form" onsubmit="return false">
        <input name="username" class="field" placeholder="New user" autocomplete="off">
        <input name="password" class="field" type="password" placeholder="Password (min. 8)" autocomplete="new-password">
        <button class="btn btn-primary" data-act="user-create"><i class="ph ph-plus"></i>Add</button>
      </form>` : ''}
    </section>
    <section><h3>Signed-in devices</h3>
      <div class="list">${s.sessions.map((x) => `
        <div class="list-row"><i class="ph ph-desktop muted"></i>
          <div class="grow"><div>${device(x.agent || '')} ${browser(x.agent || '')}${x.username ? ` <span class="muted">(${esc(x.username)})</span>` : ''}${x.current ? ' <span class="tag ok">this device</span>' : ''}</div>
            <div class="sub mono">${esc(x.ip?.replace('::ffff:', '') || '')}, active ${ago(x.last_seen)}</div></div>
          <button class="btn sm" data-act="session-revoke" data-sid="${esc(x.id)}" ${x.current ? 'data-current="1"' : ''}>Sign out</button>
        </div>`).join('') || '<div class="list-row muted">No devices signed in.</div>'}</div>
    </section>`;
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
    for (const a of p.apps) for (const s of a.scripts) items.push({ icon: 'ph-terminal', label: `${p.name} / ${a.name}: ${s}`, hint: a.cmds?.[s] || '', run: () => runScript(a.id, s) });
  }
  for (const svc of state.config.services) {
    const up = ['running', 'external'].includes(serviceState(svc));
    items.push({ icon: up ? 'ph-stop' : 'ph-play', label: `${up ? 'Stop' : 'Start'} ${svc.name}`, hint: 'Service', run: () => send({ t: up ? 'stopService' : 'startService', serviceId: svc.id }) });
  }
  items.push({ icon: 'ph-database', label: 'Databases and backups', hint: 'Services', run: go(SERVICES, 'overview') });
  items.push({ icon: 'ph-download-simple', label: 'Import project', hint: 'Folder picker', run: () => openImport('project') });
  items.push({ icon: 'ph-circle-half', label: 'Toggle theme', hint: '', run: nextTheme });
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
