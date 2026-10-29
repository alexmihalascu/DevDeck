// Draws the sidebar, toolbar, tabs and whichever page is active. Pages that own inputs (git, env) redraw themselves.
import type { Project } from '../../types.ts';
import { $, esc } from './util.ts';
import {
  state, SERVICES, termsOf, statusOf, projectOf, portOwner, serviceTerm, serviceState, visibleProjects, projectSub,
  since, uptime, statChip, statText, portLink, avatar, gitLine,
} from './state.ts';
import { queueFit } from './terminals.ts';
import { dashboardPage, overviewPage, servicesPage } from './views/pages.ts';
import { loadGit, openEnv } from './views/panels.ts';
import { drawCharts } from './charts.ts';

export function render() { renderSidebar(); renderMain(); }

/** 5 s stats tick: update numbers and charts in place, no full re-render. */
export function drawStats() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-stat]')) el.textContent = statText(el.dataset.stat!);
  drawCharts();
}

function renderSidebar() {
  const running = termsOf((m) => m.status === 'running');
  $('#running-count').textContent = running.length ? String(running.length) : '';
  $('#running').innerHTML = running.map((m) => `
    <button class="row" data-act="focus" data-tid="${m.id}">
      <span class="dot running"></span>
      <span class="row-main"><span class="row-title">${esc(m.title)}</span><span class="row-sub">${esc(projectOf(m.projectId)?.name)}, up ${uptime(m)} ${statChip(`t${m.id}`)}</span></span>
      ${portLink(m)}
    </button>`).join('');

  $('#services').innerHTML = state.config.services.map((svc) => {
    const st = serviceState(svc);
    const m = serviceTerm(svc);
    const owner = portOwner(svc.port);
    const sub = st === 'running' ? `up ${uptime(m)}` : st === 'external' ? `up ${since(owner && owner.startedAt) || '?'}, started outside` : st === 'error' ? `crashed, exit ${m?.code}` : 'stopped';
    return `<button class="row${state.selected === SERVICES ? ' selected-soft' : ''}" data-act="select" data-pid="${SERVICES}">
      <span class="dot ${st}"></span>
      <span class="row-main"><span class="row-title">${esc(svc.name)}</span><span class="row-sub">${sub}</span></span>
    </button>`;
  }).join('') || `<button class="row" data-act="select" data-pid="${SERVICES}"><span class="row-main"><span class="row-sub">MySQL, Apache, Redis... add one</span></span></button>`;

  $('[data-act=toggle-hidden]').classList.toggle('on', state.showHidden);
  const list = visibleProjects();
  $('#projects').innerHTML = list.map((p) => {
    const metas = termsOf((m) => m.projectId === p.id);
    const n = metas.filter((m) => m.status === 'running').length;
    const st = statusOf(metas);
    const cls = ['row', state.selected === p.id && 'selected', p.hidden && 'is-hidden'].filter(Boolean).join(' ');
    return `<button class="${cls}" data-act="select" data-pid="${esc(p.id)}">
      <span class="avatar-wrap">${avatar(p)}${st ? `<span class="dot ${st} badge"></span>` : ''}</span>
      <span class="row-main"><span class="row-title">${esc(p.name)}</span><span class="row-sub git-line">${gitLine(p) || esc(projectSub(p))}</span></span>
      ${n ? `<span class="count">${n}</span>` : ''}
    </button>`;
  }).join('') || `<p class="side-empty">${state.config.projects.length ? 'No matching projects.' : 'No projects yet.'}</p>`;
}

const viewToggle = (grid: boolean) => `<div class="seg">
  <button class="icon-btn${grid ? '' : ' on'}" data-act="view" data-view="tabs" title="One terminal at a time"><i class="ph ph-tabs"></i></button>
  <button class="icon-btn${grid ? ' on' : ''}" data-act="view" data-view="grid" title="All terminals side by side"><i class="ph ph-squares-four"></i></button></div>`;

function toolbar(project: Project | undefined, grid: boolean) {
  if (!project) return `<div class="tb-title"><h1>Dashboard</h1><span class="row-sub">Usage, processes and projects at a glance</span></div>
    <button class="btn" data-act="import" data-kind="project"><i class="ph ph-download-simple"></i>Import project</button>
    <button class="btn" data-act="import" data-kind="root"><i class="ph ph-folder-plus"></i>Add workspace</button>`;
  if (project.id === SERVICES) return `<div class="tb-title"><h1>Services</h1><span class="row-sub">Databases and servers that live outside your projects</span></div>
    <button class="btn btn-primary" data-act="edit-service"><i class="ph ph-plus"></i>Add service</button>
    <button class="btn" data-act="detect-xampp"><i class="ph ph-magic-wand"></i>Detect XAMPP</button>${viewToggle(grid)}`;
  const p = project;
  return `<div class="tb-title">
      <h1>${avatar(p, 'lg')}${esc(p.name)}<span class="git-line">${gitLine(p)}</span></h1>
      <span class="row-sub mono" title="${esc(p.path)}">${esc(p.path)}</span>
    </div>
    <button class="btn btn-primary" data-act="start-all" data-pid="${esc(p.id)}" ${p.apps.some((a) => a.autostart) ? '' : 'disabled title="Star a script first"'}><i class="ph-fill ph-play"></i>Start all</button>
    <button class="btn" data-act="stop-all" data-pid="${esc(p.id)}"><i class="ph ph-stop"></i>Stop all</button>
    <button class="icon-btn host-only" data-act="open" data-with="code" data-path="${esc(p.path)}" title="Open in VS Code"><i class="ph ph-code"></i></button>
    <button class="icon-btn host-only" data-act="open" data-with="explorer" data-path="${esc(p.path)}" title="Open in Explorer"><i class="ph ph-folder-open"></i></button>
    <button class="icon-btn host-only" data-act="open-wt" data-pid="${esc(p.id)}" title="Open starred scripts in Windows Terminal"><i class="ph ph-arrow-square-out"></i></button>
    <button class="icon-btn" data-act="hide" data-pid="${esc(p.id)}" title="${p.hidden ? 'Unhide project' : 'Hide project'}"><i class="ph ${p.hidden ? 'ph-eye' : 'ph-eye-slash'}"></i></button>
    ${viewToggle(grid)}`;
}

function renderMain() {
  const project = projectOf(state.selected);
  if (!project) state.selected = null;
  const mine = project ? termsOf((m) => m.projectId === project.id) : [];
  let activeId = project ? state.active[project.id] : null;
  const isPage = (id: string | null | undefined) => id === 'overview' || ((id === 'git' || id === 'env') && project?.id !== SERVICES);
  if (!isPage(activeId) && !mine.some((m) => m.id === activeId)) activeId = 'overview';
  const grid = state.view === 'grid';
  const showPage = !project || isPage(activeId);

  $('#toolbar').innerHTML = toolbar(project, grid);
  const tab = (page: string, icon: string, label: string, extra = '') => `<div class="tab page-tab${activeId === page ? ' active' : ''}" role="tab" data-act="page" data-page="${page}" data-pid="${esc(project!.id)}"><i class="ph ${icon}"></i>${label}${extra}</div>`;
  $('#tabs').innerHTML = !project ? '' : `
    ${tab('overview', 'ph-house', 'Overview')}
    ${project.id !== SERVICES ? tab('git', 'ph-git-branch', 'Git', state.git[project.id]?.changed ? ` <span class="count-pill">${state.git[project.id].changed}</span>` : '') : ''}
    ${project.envFiles?.length ? tab('env', 'ph-key', 'Env', ` <span class="count-pill">${project.envFiles.length}</span>`) : ''}
    ${mine.map((m) => `
      <div class="tab${m.id === activeId ? ' active' : ''}" role="tab" data-act="focus" data-tid="${m.id}">
        <span class="dot ${statusOf([m])}"></span>${esc(m.title)} ${portLink(m)} ${uptime(m)}${m.status === 'running' ? statChip(`t${m.id}`) : ''}
        ${m.status === 'exited' && !m.killed && m.code ? `<span class="exit">${m.conflict ? `port ${m.conflict} busy` : `exit ${m.code}`}</span>` : ''}
        ${m.status === 'running' ? '<button class="icon-btn" data-act="kill" title="Stop"><i class="ph ph-stop"></i></button>' : ''}
        <button class="icon-btn" data-act="restart" title="Restart"><i class="ph ph-arrow-clockwise"></i></button>
        <button class="icon-btn" data-act="close" title="Close"><i class="ph ph-x"></i></button>
      </div>`).join('')}`;

  const page = $('#page');
  page.classList.toggle('visible', showPage);
  page.classList.toggle('full', activeId === 'git');
  if (showPage && project && activeId === 'env') {
    if (page.dataset.view !== `env:${project.id}`) { page.dataset.view = `env:${project.id}`; openEnv(project); }
  } else if (showPage && project && activeId === 'git') {
    // The git page owns inputs (commit message, checkboxes); it redraws only when its own data changes.
    if (page.dataset.view !== `git:${project.id}`) { page.dataset.view = `git:${project.id}`; loadGit(project.id); }
  } else if (showPage) {
    page.dataset.view = '';
    const scroll = page.scrollTop;
    page.innerHTML = project?.id === SERVICES ? servicesPage() : project ? overviewPage(project) : dashboardPage();
    page.scrollTop = scroll;
    drawCharts();
  }

  $('#stage').classList.toggle('grid', grid && !showPage);
  for (const t of state.terms.values()) {
    const m = t.meta;
    t.el.classList.toggle('visible', !showPage && m.projectId === project?.id && (grid || m.id === activeId));
    t.el.classList.toggle('active', m.id === activeId);
    (t.el.querySelector('.pane-title') as HTMLElement).innerHTML = `<span class="dot ${statusOf([m])}"></span>${esc(m.title)} ${portLink(m)}`;
  }
  queueFit();
}
