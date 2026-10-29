// The three full pages: dashboard, project overview, services (with databases and Docker).
import type { Project, Requirement } from '../../../types.ts';
import { esc, fmtDur, fmtSize } from '../util.ts';
import { api } from '../net.ts';
import {
  state, SERVICES, termsOf, termFor, statusOf, projectOf, portOwner, serviceTerm, serviceState, visibleProjects,
  since, uptime, statChip, portLink, avatar, gitLine, emptyState, skeletonRows,
} from '../state.ts';
import { usageCharts, processTable, processRows } from '../charts.ts';
import { render } from '../render.ts';

// ---------- dashboard ----------
export function dashboardPage(): string {
  const { projects, roots, manual } = state.config;
  if (!projects.length) {
    return `<div class="page-inner"><div class="hero"><h1>Your projects, one place</h1>
      <p class="muted">Import a project or add the folder where you keep them. Scripts from every package.json become one-click terminals.</p></div>
      ${emptyState('ph-folders', 'No projects yet', 'Start with your workspace folder, like Desktop\\code.',
        `<button class="btn btn-primary" data-act="import" data-kind="root"><i class="ph ph-folder-plus"></i>Add workspace</button>
        <button class="btn" data-act="import" data-kind="project"><i class="ph ph-download-simple"></i>Import one project</button>`)}</div>`;
  }
  const failed = termsOf((m) => statusOf([m]) === 'error');
  const procs = processRows();
  const list = visibleProjects();
  return `<div class="page-inner">
    <div class="stats">
      <div class="stat"><span>CPU</span><b data-machine="cpu">...</b><i class="meter s1" data-meter="cpu"></i></div>
      <div class="stat"><span>Memory <small data-machine="memTotal"></small></span><b data-machine="mem">...</b><i class="meter s2" data-meter="mem"></i></div>
      <div class="stat"><span>Processes</span><b>${procs.length}${failed.length ? ` <em class="bad">${failed.length} crashed</em>` : ''}</b></div>
      <div class="stat"><span>PC uptime</span><b data-machine="uptime">...</b></div>
    </div>
    <section><h2>Resources <span class="muted">last hour</span></h2><div data-usage="machine">${usageCharts()}</div></section>
    ${failed.length ? `<section><h2>Crashed</h2><div class="list">${failed.map((m) => `
      <div class="list-row click" tabindex="0" data-act="focus" data-tid="${m.id}">
        <span class="dot error"></span>
        <div class="grow"><div>${esc(m.title)}</div><div class="sub">${esc(projectOf(m.projectId)?.name)}, ${m.conflict ? `port ${m.conflict} was busy` : `exit code ${m.code}`}${m.endedAt ? `, ${fmtDur(Date.now() - m.endedAt)} ago` : ''}</div></div>
        <button class="btn sm" data-act="restart"><i class="ph ph-arrow-clockwise"></i>Restart</button>
      </div>`).join('')}</div></section>` : ''}
    <section><h2>Processes <span class="muted">${procs.length}</span></h2><div data-proc-table="">${processTable(procs)}</div></section>
    <section>
      <h2>Projects <span class="muted">${list.length}</span></h2>
      <div class="cards">${list.map((p) => {
        const n = termsOf((m) => m.projectId === p.id && m.status === 'running').length;
        const stack = [...new Set(p.apps.flatMap((a) => a.stack || []))].slice(0, 5);
        return `<button class="card" data-act="select" data-pid="${esc(p.id)}">
          <div class="card-head">${avatar(p)}${esc(p.name)}${n ? `<span class="count">${n} running</span>` : ''}</div>
          <div class="tags">${p.apps.filter((a) => a.name !== p.name).map((a) => `<span class="tag">${esc(a.name)}</span>`).join('')}${stack.map((s) => `<span class="tag accent">${esc(s)}</span>`).join('')}</div>
          <div class="sub ${gitLine(p) ? 'git-line' : 'clip-start'}">${gitLine(p) || `<bdi>${esc(p.path)}</bdi>`}</div>
        </button>`;
      }).join('')}</div>
    </section>
    <section>
      <h2>Folders</h2>
      <div class="list">${[...roots.map((r) => ['root', r]), ...manual.map((r) => ['manual', r])].map(([kind, r]) => `
        <div class="list-row">
          <i class="ph ${kind === 'root' ? 'ph-folder-simple' : 'ph-app-window'} muted"></i>
          <div class="grow"><div class="mono clip-start" title="${esc(r)}"><bdi>${esc(r)}</bdi></div><div class="sub">${kind === 'root' ? 'Workspace, every subfolder is a project' : 'Imported project'}</div></div>
          <button class="btn sm" data-act="remove-folder" data-kind="${kind}" data-path="${esc(r)}">Remove</button>
        </div>`).join('')}</div>
    </section>
  </div>`;
}

// ---------- project overview ----------
export async function loadRequirements(projectId: string, force = false) {
  const r = state.requirements[projectId];
  if (!force && (r?.loading || (r && Date.now() - r.at < 15000))) return;
  state.requirements[projectId] = { items: r?.items || [], at: r?.at || 0, loading: true };
  try {
    state.requirements[projectId] = { items: await api<Requirement[]>('POST', '/api/requirements', { projectId }), at: Date.now() };
  } catch { state.requirements[projectId] = { items: r?.items || [], at: Date.now() }; }
  if (state.selected === projectId) render();
}

const REQ_ICON = { ok: 'ph-check-circle', warn: 'ph-warning', fail: 'ph-x-circle', unknown: 'ph-question' };
function requirementsBlock(p: Project): string {
  loadRequirements(p.id);
  const items = state.requirements[p.id]?.items || [];
  const bad = items.filter((i) => i.status === 'fail' || i.status === 'warn').length;
  const services = state.config.services;
  const uses = new Set(p.services || []);
  return `<section class="app-block req">
    <div class="app-top">
      <i class="ph ${bad ? 'ph-warning-circle bad' : 'ph-seal-check good'}"></i>
      <h3>Requirements</h3>
      <span class="muted small">${!items.length ? 'checking...' : bad ? `${bad} need attention` : 'all good'}</span>
      <div class="actions"><button class="icon-btn" data-act="req-refresh" title="Check again"><i class="ph ph-arrow-clockwise"></i></button></div>
    </div>
    <div class="proj-settings">
      <label class="check" title="After a reboot, when Devdeck starts, run Start all for this project"><input type="checkbox" data-proj-setting="bootStart" ${p.bootStart ? 'checked' : ''}> Start when Devdeck starts</label>
      ${services.length ? `<span class="muted small">Needs</span>${services.map((svc) => `
        ${p.db && svc.id === 'xampp-mysql' && !uses.has(svc.id)
          // Detected from .env / wp-config: always on, so it can't be unticked by mistake.
          ? `<label class="check" title="This project uses the database ${esc(p.db)}, so ${esc(svc.name)} starts before its scripts"><input type="checkbox" checked disabled> ${esc(svc.name)} <span class="muted small">detected</span></label>`
          : `<label class="check" title="Its scripts start ${esc(svc.name)} first (if it isn't running) and wait for it"><input type="checkbox" data-proj-service="${esc(svc.id)}" ${uses.has(svc.id) ? 'checked' : ''}> ${esc(svc.name)}</label>`}`).join('')}` : ''}
    </div>
    ${!items.length && state.requirements[p.id]?.loading ? skeletonRows(2) : ''}
    ${items.map((i) => `<div class="req-row ${i.status}">
      <i class="ph-fill ${REQ_ICON[i.status]}" aria-label="${i.status}"></i>
      <span class="req-label">${esc(i.label)}</span><span class="req-detail">${esc(i.detail)}</span>
      ${i.fix ? `<button class="btn sm${i.status === 'fail' ? ' btn-primary' : ''}" data-act="req-fix" data-kind="${i.fix.kind}" data-arg="${esc(i.fix.arg)}">${esc(i.fix.label)}</button>` : '<span></span>'}
    </div>`).join('')}
  </section>`;
}

function infoStrip(p: Project): string {
  const parts = [
    p.url && `<a class="btn sm" href="${esc(p.url)}" target="_blank" rel="noopener"><i class="ph ph-globe"></i>${esc(p.url.replace(/^https?:\/\//, ''))}</a>`,
    p.db && `<span class="info-db"><i class="ph ph-database"></i><span class="mono">${esc(p.db)}</span>
      <a class="btn sm" href="/phpmyadmin/index.php?route=/database/structure&db=${encodeURIComponent(p.db)}" target="_blank" rel="noopener">phpMyAdmin</a>
      <button class="btn sm" data-act="db-backup" data-db="${esc(p.db)}" ${state.dbBusy ? 'disabled' : ''}><i class="ph ph-floppy-disk"></i>Backup</button></span>`,
    p.envFiles?.length && `<button class="btn sm" data-act="env-tab" data-pid="${esc(p.id)}"><i class="ph ph-key"></i>${p.envFiles.length} env file${p.envFiles.length > 1 ? 's' : ''}</button>`,
  ].filter(Boolean);
  return parts.length ? `<div class="info-strip">${parts.join('')}</div>` : '';
}

// A script crashed because its port is taken: say by whom, offer to free it.
function conflictNote(m: ReturnType<typeof termsOf>[number] | undefined): string {
  if (!m?.conflict || m.status === 'running') return '';
  const owner = portOwner(m.conflict);
  return `<span class="conflict" title="Port ${m.conflict} is busy">:${m.conflict} busy${owner ? ` (${esc(owner.name || 'pid')} ${owner.pid})` : ''}
    ${owner ? `<button class="btn sm btn-danger" data-act="free-port" data-pid-kill="${owner.pid}" data-tid="${m.id}">Kill it and retry</button>` : ''}</span>`;
}

export function overviewPage(p: Project): string {
  const running = processRows(p.id);
  return `<div class="page-inner">${infoStrip(p)}${requirementsBlock(p)}
    ${running.length ? `<section><h2>Usage <span class="muted">${running.length} running</span></h2>
      <div data-usage="${esc(p.id)}">${usageCharts(running.map((r) => r.key))}</div>
      <div data-proc-table="${esc(p.id)}">${processTable(running)}</div></section>` : ''}
    ${p.apps.map((a) => {
      const appTerms = termsOf((m) => m.appId === a.id);
      const rel = a.path === p.path ? '.' : a.path.slice(p.path.length + 1);
      return `<section class="app-block" data-aid="${esc(a.id)}" data-pid="${esc(p.id)}">
        <div class="app-top">
          <span class="dot ${statusOf(appTerms)}"></span><h3>${esc(a.name)}</h3>
          <div class="tags"><span class="tag">${esc(a.pm)}</span>${a.version ? `<span class="tag">v${esc(a.version)}</span>` : ''}${(a.stack || []).map((s) => `<span class="tag accent">${esc(s)}</span>`).join('')}</div>
          <div class="actions">
            ${a.install && a.install !== 'ok' ? `<span class="tag err" title="Fix it under Requirements">${a.install === 'missing' ? 'not installed' : 'deps missing'}</span>` : ''}
            <button class="btn sm" data-act="shell"><i class="ph ph-terminal-window"></i>Shell</button>
            ${a.path !== p.path ? `<button class="icon-btn host-only" data-act="open" data-with="code" data-path="${esc(a.path)}" title="Open ${esc(rel)} in VS Code"><i class="ph ph-code"></i></button>` : ''}
          </div>
        </div>
        ${a.scripts.map((s) => {
          const m = termFor(a.id, s)?.meta;
          const run = m?.status === 'running';
          const star = a.autostart === s;
          return `<div class="script-row${run ? ' running' : ''}">
            ${run ? `<button class="icon-btn run stop" data-act="kill" data-tid="${m!.id}" title="Stop"><i class="ph-fill ph-stop"></i></button>`
              : `<button class="icon-btn run" data-act="run" data-script="${esc(s)}" title="${esc(a.pm)} run ${esc(s)}"><i class="ph-fill ph-play"></i></button>`}
            <span class="name">${esc(s)}</span>
            <span class="cmd" title="${esc(a.cmds?.[s])}">${esc(a.cmds?.[s])}</span>
            <span class="meta">
              ${run ? `${uptime(m)} ${statChip(`t${m!.id}`)}` : ''}
              ${conflictNote(m)}
              ${m ? portLink(m) : ''}
              ${m ? `<button class="btn sm" data-act="focus" data-tid="${m.id}">${run ? 'View' : m.killed || !m.code ? 'Log' : `exit ${m.code}`}</button>` : ''}
              <button class="icon-btn sm star${star ? ' on' : ''}" data-act="auto" data-script="${esc(s)}" title="${star ? 'Remove from Start all' : 'Include in Start all'}"><i class="${star ? 'ph-fill' : 'ph'} ph-star"></i></button>
            </span>
          </div>`;
        }).join('') || '<p class="list-row muted">No scripts.</p>'}
      </section>`;
    }).join('')}</div>`;
}

// ---------- services ----------
export async function loadDb(force = false) {
  if (!force && (state.dbLoading || Date.now() - state.dbAt < 10000)) return;
  state.dbLoading = true;
  try { state.dbInfo = await api('POST', '/api/db/list'); } catch (err) { state.dbInfo = { databases: null, error: (err as Error).message, backups: [] }; }
  state.dbAt = Date.now();
  state.dbLoading = false;
  if (state.selected === SERVICES) render();
}

function dockerSection(): string {
  const d = state.docker;
  if (!d.available) return '';
  if (!d.running) return `<section><h2>Docker</h2>${emptyState('ph-cube', 'Docker engine is not running', 'Start Docker Desktop and containers show up here.', '', true)}</section>`;
  return `<section><h2>Docker <span class="muted">${d.containers.filter((c) => c.State === 'running').length} of ${d.containers.length} running</span></h2>
    ${d.containers.length ? `<div class="list">${d.containers.map((c) => {
      const up = c.State === 'running';
      return `<div class="list-row" data-cid="${esc(c.ID)}">
        <span class="dot ${up ? 'running' : c.State === 'exited' && !/Exited \(0\)/.test(c.Status) ? 'error' : ''}"></span>
        <div class="grow"><div>${esc(c.Names)}${c.Compose ? ` <span class="tag">${esc(c.Compose)}</span>` : ''}</div>
          <div class="sub">${esc(c.Image)} · ${esc(c.Status)}${c.Ports ? ` · ${esc(c.Ports.replace(/0\.0\.0\.0:|\[::\]:/g, ''))}` : ''}</div></div>
        ${up ? `<button class="btn sm btn-danger" data-act="docker" data-action="stop"><i class="ph ph-stop"></i>Stop</button>
             <button class="btn sm" data-act="docker" data-action="restart"><i class="ph ph-arrow-clockwise"></i>Restart</button>`
          : '<button class="btn sm" data-act="docker" data-action="start"><i class="ph-fill ph-play"></i>Start</button>'}
        <button class="btn sm" data-act="docker-logs"><i class="ph ph-file-text"></i>Logs</button>
      </div>`;
    }).join('')}</div>` : emptyState('ph-cube', 'No containers yet', '', '', true)}
  </section>`;
}

function databaseSection(): string {
  if (!state.config.services.some((s) => s.id === 'xampp-mysql')) return '';
  const info = state.dbInfo;
  if (!info) return `<section><h2>Databases</h2><div class="list">${skeletonRows(3)}</div></section>`;
  const dbs = (info.databases || []).filter((d) => !d.system);
  const sc = info.schedule;
  return `<section>
    <h2>Databases ${state.dbBusy ? `<span class="muted">${esc(state.dbBusy)}...</span>` : ''}
      <span class="h2-actions">
        <button class="btn sm" data-act="db-refresh"><i class="ph ph-arrow-clockwise"></i>Refresh</button>
        <button class="btn sm host-only" data-act="db-folder"><i class="ph ph-folder-open"></i>Backups folder</button>
        <button class="btn sm" data-act="db-creds"><i class="ph ph-user"></i>Credentials</button>
      </span></h2>
    ${info.error ? emptyState('ph-plugs', "Can't read databases", esc(info.error), '', true)
      : dbs.length ? `<div class="list">${dbs.map((d) => `
        <div class="list-row"><i class="ph ph-database muted"></i>
          <div class="grow"><div class="mono">${esc(d.name)}</div><div class="sub">${d.tables} tables, ${fmtSize(d.size)}</div></div>
          <a class="btn sm" href="/phpmyadmin/index.php?route=/database/structure&db=${encodeURIComponent(d.name)}" target="_blank" rel="noopener">phpMyAdmin</a>
          <button class="btn sm" data-act="db-backup" data-db="${esc(d.name)}" ${state.dbBusy ? 'disabled' : ''}><i class="ph ph-floppy-disk"></i>Backup</button>
        </div>`).join('')}</div>` : emptyState('ph-database', 'No databases yet', 'Create one in phpMyAdmin.', '', true)}
    <form id="backup-form" class="backup-form" onsubmit="return false">
      <label class="check"><input type="checkbox" name="enabled" ${sc?.enabled ? 'checked' : ''}> Automatic backups every</label>
      <input class="field mono" name="everyHours" type="number" min="1" max="168" value="${sc?.everyHours || 24}" aria-label="Hours between backups"><span class="muted">hours, keep the last</span>
      <input class="field mono" name="keep" type="number" min="1" max="100" value="${sc?.keep || 7}" aria-label="Copies to keep"><span class="muted">per database</span>
      <label class="check"><input type="checkbox" name="beforePull" ${sc?.beforePull !== false ? 'checked' : ''}> Back up a project's database before git pull</label>
      <button class="btn sm" data-act="backup-schedule-save">Save</button>
      ${sc?.lastRun ? `<span class="muted small">last run ${new Date(sc.lastRun).toLocaleString()}</span>` : ''}
    </form>
    <h2 class="sub-h">Backups <span class="muted">${info.backups.length}</span></h2>
    ${info.backups.length ? `<div class="list">${info.backups.map((b) => `
      <div class="list-row"><i class="ph ph-file-sql muted"></i>
        <div class="grow"><div class="mono">${esc(b.file)}</div><div class="sub">${esc(b.name)}, ${fmtSize(b.size)}, ${new Date(b.at).toLocaleString()}${({ 'pre-restore': ', copy made before a restore', auto: ', automatic', 'pre-pull': ', made before git pull' } as Record<string, string>)[b.kind] || ''}</div></div>
        <button class="btn sm" data-act="db-restore" data-file="${esc(b.file)}" data-db="${esc(b.name)}" ${state.dbBusy ? 'disabled' : ''}><i class="ph ph-clock-counter-clockwise"></i>Restore</button>
        <button class="icon-btn" data-act="db-delete" data-file="${esc(b.file)}" title="Delete backup"><i class="ph ph-trash"></i></button>
      </div>`).join('')}</div>` : emptyState('ph-file-sql', 'No backups yet', "They are plain .sql files in Devdeck's data/backups folder.", '', true)}
  </section>`;
}

export function servicesPage(): string {
  loadDb();
  const services = state.config.services;
  if (!services.length) {
    return `<div class="page-inner">${emptyState('ph-hard-drives', 'No services yet', 'A service is any long-running command: MySQL, Apache with phpMyAdmin, Redis, a Docker container.',
      `<button class="btn btn-primary" data-act="edit-service"><i class="ph ph-plus"></i>Add service</button>
      <button class="btn" data-act="detect-xampp"><i class="ph ph-magic-wand"></i>Detect XAMPP</button>`)}${dockerSection()}</div>`;
  }
  return `<div class="page-inner">${services.map((svc) => {
    const m = serviceTerm(svc);
    const st = serviceState(svc);
    const label = ({ running: 'Running', external: 'Running, started outside Devdeck', error: `Crashed (exit ${m?.code})` } as Record<string, string>)[st] || 'Stopped';
    const owner = portOwner(svc.port);
    return `<section class="app-block" data-sid="${esc(svc.id)}">
      <div class="app-top">
        <span class="dot ${st}"></span><h3>${esc(svc.name)}</h3>
        <div class="tags">
          <span class="tag ${st === 'running' || st === 'external' ? 'ok' : ''}">${label}${st === 'running' ? ` · ${uptime(m)}` : st === 'external' && owner && owner.startedAt ? ` · ${since(owner.startedAt)}` : ''}</span>
          ${owner ? `<span class="tag" title="Process listening on :${svc.port}">${esc(owner.name || 'pid')} ${owner.pid}</span>` : ''}
          ${m?.status === 'running' ? statChip(`t${m.id}`) : owner ? statChip(`p${svc.port}`) : ''}
          ${svc.port ? `<span class="tag ${owner ? 'ok' : ''}">:${svc.port} ${owner ? 'listening' : 'closed'}</span>` : ''}
          ${m?.status === 'exited' && m.endedAt ? `<span class="tag">stopped ${fmtDur(Date.now() - m.endedAt)} ago</span>` : ''}
        </div>
        <div class="actions">
          ${svc.url ? `<a class="btn sm" href="${esc(svc.url)}" target="_blank" rel="noopener"><i class="ph ph-arrow-square-out"></i>Open</a>` : ''}
          ${m?.status === 'running'
            ? `<button class="btn sm btn-danger" data-act="kill" data-tid="${m.id}"><i class="ph ph-stop"></i>Stop</button>
               <button class="btn sm" data-act="restart" data-tid="${m.id}"><i class="ph ph-arrow-clockwise"></i>Restart</button>`
            : st === 'external' ? (svc.stopCmd ? '<button class="btn sm btn-danger" data-act="stop-service"><i class="ph ph-stop"></i>Stop</button>' : '')
            : '<button class="btn sm" data-act="start-service"><i class="ph-fill ph-play"></i>Start</button>'}
          ${m ? `<button class="btn sm" data-act="focus" data-tid="${m.id}"><i class="ph ph-terminal-window"></i>Output</button>` : ''}
          <button class="icon-btn" data-act="edit-service" title="Edit"><i class="ph ph-pencil-simple"></i></button>
          <button class="icon-btn" data-act="remove-service" title="Remove"><i class="ph ph-trash"></i></button>
        </div>
      </div>
      <div class="script-row"><i class="ph ph-terminal muted center"></i><span class="name">command</span><span class="cmd" title="${esc(svc.cmd)}">${esc(svc.cmd)}</span><span></span></div>
      ${svc.logs.map((f) => `<div class="script-row click" tabindex="0" data-act="log" data-file="${esc(f)}">
        <i class="ph ph-file-text muted center"></i><span class="name">${esc(f.split(/[\\/]/).pop())}</span>
        <span class="cmd" title="${esc(f)}">${esc(f)}</span><span class="meta"><span class="btn sm">View log</span></span></div>`).join('')}
    </section>`;
  }).join('')}${databaseSection()}${dockerSection()}</div>`;
}
