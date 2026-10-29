// The one place the UI keeps what it knows, plus read-only selectors and small HTML pieces built from it.
import type {
  DbInfo, BackupFile, BackupSchedule, DockerState, GitCommit, GitStatus, GitSummary, Health, History,
  Machine, Me, Project, PublicConfig, Requirement, Service, SessionRow, Stats, TermMeta, UserRow,
} from '../../types.ts';
import { esc, fmtDur, fmtMem, fmtPct, hue, store } from './util.ts';

export const SERVICES = '__services';
export type Page = 'overview' | 'git' | 'env';
export type XTerm = InstanceType<typeof Terminal>;
export type Fit = InstanceType<typeof FitAddon.FitAddon>;
export interface TermView { meta: TermMeta & { sized?: boolean }; term: XTerm; fit: Fit; el: HTMLElement }

export interface GitView {
  projectId: string;
  data: (GitStatus & { log: GitCommit[] }) | null;
  error?: string | null;
  file: string | null;
  commit: string | null;
  diff: string;
  diffLoading?: boolean;
  checked: Set<string>;
  unchecked?: Set<string>;
  output: string;
  ok?: boolean;
  busy?: boolean;
  message: string;
}
export interface EnvView { projectId: string; file: string; text: string; reveal: boolean; editing: boolean; error?: string | null }
export interface DbList { databases: DbInfo[] | null; backups: BackupFile[]; error: string | null; schedule?: BackupSchedule }

export const state = {
  config: { roots: [], manual: [], projects: [], services: [], mysql: { user: 'root', hasPassword: false } } as PublicConfig,
  terms: new Map<string, TermView>(),
  selected: store.get<string | null>('selected', null), // project id, null = dashboard
  active: store.get<Record<string, string>>('active', {}), // projectId -> page or termId
  view: store.get<'tabs' | 'grid'>('view', 'tabs'),
  query: '',
  showHidden: false,
  pendingFocus: null as string | null,
  health: {} as Health,
  git: {} as Record<string, GitSummary>,
  docker: { available: false, running: false, containers: [] } as DockerState,
  stats: {} as Stats,
  machine: null as Machine | null,
  history: { machine: [], series: {}, labels: {} } as History,
  dbInfo: null as DbList | null,
  dbAt: 0,
  dbLoading: false,
  dbBusy: '',
  requirements: {} as Record<string, { items: Requirement[]; at: number; loading?: boolean }>,
  envView: null as EnvView | null,
  gitView: null as GitView | null,
  notify: store.get('notify', false),
  me: { local: true } as Me,
  settings: { users: [] as UserRow[], sessions: [] as SessionRow[], mfa: null as null | { uid: string; name: string; secret: string; qr: string }, error: '' },
};

export function persist() {
  store.set('selected', state.selected);
  store.set('active', state.active);
  store.set('view', state.view);
}

// ---------- selectors ----------
export const termsOf = (pred: (m: TermMeta) => boolean) => [...state.terms.values()].map((t) => t.meta).filter(pred);
export const termFor = (appId: string, script: string) => [...state.terms.values()].find((t) => t.meta.appId === appId && t.meta.script === script);
export const statusOf = (metas: TermMeta[]): '' | 'running' | 'error' => {
  if (metas.some((m) => m.status === 'running')) return 'running';
  if (metas.some((m) => m.status === 'exited' && m.code !== 0 && !m.killed)) return 'error';
  return '';
};
const SERVICES_PROJECT: Project = { id: SERVICES, name: 'Services', path: '', apps: [], branch: null, icon: null, envFiles: [], db: null };
export const projectOf = (id: string | null | undefined) => id === SERVICES ? SERVICES_PROJECT : state.config.projects.find((p) => p.id === id);
export const portOwner = (port: number | null | undefined) => (port && state.health[port]) || null;
export const serviceTerm = (svc: Service) => termsOf((m) => m.serviceId === svc.id)[0];
/** running = started here; external = its port answers but Devdeck did not start it; error = crashed. */
export const serviceState = (svc: Service): '' | 'running' | 'external' | 'error' => {
  const m = serviceTerm(svc);
  if (m?.status === 'running') return 'running';
  if (svc.port && state.health[svc.port]) return 'external';
  return statusOf(m ? [m] : []);
};
export const visibleProjects = () => {
  const q = state.query.trim().toLowerCase();
  return state.config.projects.filter((p) => (state.showHidden || !p.hidden || p.id === state.selected)
    && (!q || p.name.toLowerCase().includes(q) || p.apps.some((a) => a.stack?.some((s) => s.includes(q)))));
};
export const projectSub = (p: Project) => p.apps.length > 1 || p.apps[0]?.name !== p.name
  ? p.apps.map((a) => a.name).join(', ')
  : (p.apps[0]?.stack || []).slice(0, 3).join(', ') || p.apps[0]?.pm || '';

// ---------- small HTML pieces ----------
/** Empty state: icon, title, one line of what to do, optional actions. compact = one row, for inside a section. */
export const emptyState = (icon: string, title: string, text = '', actions = '', compact = false) => `<div class="empty-box${compact ? ' compact' : ''}">
  <span class="empty-media"><i class="ph ${icon}"></i></span><strong>${title}</strong>${text ? `<p>${text}</p>` : ''}
  ${actions ? `<div class="empty-actions">${actions}</div>` : ''}</div>`;
/** Placeholder rows while a list loads, sized like the rows that replace them. */
export const skeletonRows = (n = 3) => `<div class="skeleton">${Array.from({ length: n }, (_, i) => `<div class="skel-row"><span class="skel" style="width:16px;height:16px;border-radius:50%"></span><span class="skel" style="width:${[38, 26, 32, 22][i % 4]}%"></span><span class="skel" style="width:${[18, 24, 14, 20][i % 4]}%;margin-left:auto"></span></div>`).join('')}</div>`;
/** Live counter: the 1 s ticker in main.ts updates every [data-since]. */
export const since = (ms: number | null | undefined) => ms ? `<span class="uptime" data-since="${ms}">${fmtDur(Date.now() - ms)}</span>` : '';
export const uptime = (m: TermMeta | undefined) => m?.status === 'running' ? since(m.startedAt) : '';
export const statText = (key: string) => {
  const s = state.stats[key];
  return s ? `${fmtPct(s.cpu)} · ${fmtMem(s.mem)}` : '';
};
/** CPU · RAM text, refreshed in place every 5 s (see drawStats). */
export const statChip = (key: string) => `<span class="stat-chip" data-stat="${key}">${statText(key)}</span>`;
export const portLink = (m: { port: number | null }) => m.port
  ? `<a class="port" href="http://${location.hostname}:${m.port}" target="_blank" rel="noopener" title="Open in browser">:${m.port}</a>` : '';
export const avatar = (p: Project, cls = '') => {
  const letter = `<span class="avatar-letter" style="--h:${hue(p.name)}">${esc(p.name[0]?.toUpperCase())}</span>`;
  return p.icon
    ? `<span class="avatar ${cls}"><img src="/api/icon?id=${encodeURIComponent(p.id)}" alt="" loading="lazy" onerror="this.replaceWith(this.nextElementSibling.content.cloneNode(true))"><template>${letter}</template></span>`
    : `<span class="avatar ${cls}">${letter}</span>`;
};
export const gitLine = (p: Project) => {
  const g = state.git[p.id];
  if (!g) return '';
  return [g.branch && `<span class="g-branch"><i class="ph ph-git-branch"></i>${esc(g.branch)}</span>`,
    g.changed && `<span class="g-changed" title="Uncommitted changes">${g.changed} changed</span>`,
    g.ahead && `<span class="g-ahead" title="Commits not pushed">${g.ahead}<i class="ph ph-arrow-up"></i></span>`,
    g.behind && `<span class="g-behind" title="Commits to pull">${g.behind}<i class="ph ph-arrow-down"></i></span>`,
  ].filter(Boolean).join('');
};
