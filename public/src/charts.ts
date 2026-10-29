// Usage charts in plain SVG. One measure per chart (never two y-axes). CPU = series-1 (blue), memory = series-2 (orange):
// the same pair on every chart, validated for colour-blind separation on both themes.
import type { Sample, TermMeta } from '../../types.ts';
import { esc, fmtDur, fmtMem, fmtPct } from './util.ts';
import { state, projectOf, since, portLink } from './state.ts';

const MAX_POINTS = 720;

/** Merge one live 'stats' message into the hour of history loaded at startup. */
export function pushStats(at: number) {
  const h = state.history;
  const m = state.machine;
  const cap = <T>(list: T[], item: T) => { list.push(item); if (list.length > MAX_POINTS) list.shift(); };
  if (m) cap(h.machine, { at, cpu: m.cpu, mem: m.memUsed, memTotal: m.memTotal });
  for (const [key, s] of Object.entries(state.stats)) cap(h.series[key] ??= [], { at, cpu: s.cpu, mem: s.mem });
}

/** Add up several processes sample by sample (all samples of one tick share the same timestamp). */
export function sumSeries(keys: string[]): Sample[] {
  const by = new Map<number, Sample>();
  for (const k of keys) for (const s of state.history.series[k] || []) {
    const t = by.get(s.at) || { at: s.at, cpu: 0, mem: 0 };
    t.cpu = (t.cpu ?? 0) + (s.cpu ?? 0);
    t.mem += s.mem;
    by.set(s.at, t);
  }
  return [...by.values()].sort((a, b) => a.at - b.at);
}

interface LineSpec { title: string; points: { at: number; v: number | null }[]; max: number; fmt: (v: number) => string; series: 1 | 2; ticks: number[] }

/** A line+area chart. Paths stretch with the card (non-scaling strokes stay 2px); text lives in HTML so it never stretches. */
export function lineChart(spec: LineSpec): string {
  const { points, max } = spec;
  const vals = points.map((p) => p.v).filter((v): v is number => v != null);
  const now = vals.at(-1), avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, peak = vals.length ? Math.max(...vals) : null;
  const t0 = points[0]?.at ?? Date.now(), t1 = points.at(-1)?.at ?? t0 + 1;
  const x = (at: number) => ((at - t0) / Math.max(t1 - t0, 1)) * 100;
  const y = (v: number) => 100 - Math.min(v / (max || 1), 1) * 100;
  // Gaps (null samples) break the line instead of drawing a fake zero.
  let d = '', area = '', run: string[] = [];
  const flush = () => {
    if (run.length > 1) { d += `M${run.join('L')}`; area += `M${run[0].split(',')[0]},100L${run.join('L')}L${run.at(-1)!.split(',')[0]},100Z`; }
    run = [];
  };
  for (const p of points) { if (p.v == null) flush(); else run.push(`${x(p.at).toFixed(2)},${y(p.v).toFixed(2)}`); }
  flush();
  const data = esc(JSON.stringify(points.map((p) => [p.at, p.v])));
  return `<figure class="chart s${spec.series}" data-points="${data}" data-fmt="${spec.fmt === fmtMem ? 'mem' : 'pct'}">
    <figcaption><span class="chart-title"><i class="key"></i>${esc(spec.title)}</span>
      <span class="chart-now">${now == null ? '...' : esc(spec.fmt(now))}</span></figcaption>
    <div class="plot">
      <div class="ticks">${spec.ticks.map((t) => `<span style="top:${y(t)}%">${esc(spec.fmt(t))}</span>`).join('')}</div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        ${spec.ticks.map((t) => `<line class="grid" x1="0" x2="100" y1="${y(t)}" y2="${y(t)}"/>`).join('')}
        <path class="area" d="${area}"/><path class="line" d="${d}"/>
      </svg>
      <div class="cross" hidden></div><div class="tip" hidden></div>
      ${points.length < 2 ? '<div class="plot-empty">Collecting samples, one every 5 seconds...</div>' : ''}
    </div>
    <div class="chart-foot"><span>last ${points.length > 1 ? fmtDur(t1 - t0) : '-'}</span><span>avg ${avg == null ? '-' : esc(spec.fmt(avg))}</span><span>peak ${peak == null ? '-' : esc(spec.fmt(peak))}</span></div>
  </figure>`;
}

/** Crosshair + tooltip: snaps to the nearest sample, so the reader aims at a time, not at a 2px line. */
export function chartHover(e: PointerEvent) {
  const fig = (e.target as Element).closest('.chart') as HTMLElement | null;
  for (const other of document.querySelectorAll<HTMLElement>('.chart .cross:not([hidden])')) if (!fig?.contains(other)) { other.hidden = true; (other.nextElementSibling as HTMLElement).hidden = true; }
  if (!fig || e.type === 'pointerleave') return;
  const plot = fig.querySelector('.plot') as HTMLElement;
  const pts = JSON.parse(fig.dataset.points || '[]') as [number, number | null][];
  if (pts.length < 2) return;
  const r = plot.getBoundingClientRect();
  const frac = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
  const t0 = pts[0][0], t1 = pts.at(-1)![0];
  const target = t0 + frac * (t1 - t0);
  const [at, v] = pts.reduce((best, p) => Math.abs(p[0] - target) < Math.abs(best[0] - target) ? p : best);
  const left = ((at - t0) / (t1 - t0)) * 100;
  const cross = fig.querySelector('.cross') as HTMLElement, tip = fig.querySelector('.tip') as HTMLElement;
  cross.hidden = tip.hidden = false;
  cross.style.left = `${left}%`;
  tip.style.left = `${Math.min(Math.max(left, 12), 88)}%`;
  tip.replaceChildren();
  const strong = document.createElement('b');
  strong.textContent = v == null ? 'no data' : fig.dataset.fmt === 'mem' ? fmtMem(v) : fmtPct(v);
  const when = document.createElement('span');
  when.textContent = new Date(at).toLocaleTimeString();
  tip.append(strong, when);
}

/** Tiny trend line for a table cell; the exact number sits next to it. */
export function sparkline(samples: Sample[], pick: 'cpu' | 'mem', series: 1 | 2, max?: number): string {
  const vals = samples.slice(-60).map((s) => s[pick]);
  const nums = vals.filter((v): v is number => v != null);
  if (nums.length < 2) return '<svg class="spark" aria-hidden="true"></svg>';
  const top = max ?? Math.max(...nums, pick === 'cpu' ? 1 : 1);
  const pts = vals.map((v, i) => v == null ? null : `${((i / (vals.length - 1)) * 100).toFixed(1)},${(30 - (v / top) * 28 - 1).toFixed(1)}`).filter(Boolean);
  return `<svg class="spark s${series}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="M${pts.join('L')}"/></svg>`;
}

export interface ProcRow { key: string; label: string; sub: string; startedAt: number | null; port: number | null; meta?: TermMeta }

/** Every process Devdeck can see: its own terminals plus services started elsewhere. */
export function processRows(projectId?: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const { meta: m } of state.terms.values()) {
    if (m.status !== 'running' || (projectId && m.projectId !== projectId)) continue;
    rows.push({ key: `t${m.id}`, label: m.title, sub: projectOf(m.projectId)?.name || '', startedAt: m.startedAt ?? null, port: m.port, meta: m });
  }
  if (!projectId) for (const svc of state.config.services) {
    const owner = svc.port ? state.health[svc.port] : null;
    if (owner && !rows.some((r) => r.meta?.serviceId === svc.id)) rows.push({ key: `p${svc.port}`, label: svc.name, sub: 'started outside Devdeck', startedAt: owner.startedAt ?? null, port: svc.port });
  }
  return rows;
}

/** The table view of the charts: every number readable without hovering. */
export function processTable(rows: ProcRow[]): string {
  if (!rows.length) return '<div class="empty-box">Nothing running right now. Start a script or a service and its usage shows up here.</div>';
  const longest = Math.max(...rows.map((r) => r.startedAt ? Date.now() - r.startedAt : 0), 1);
  return `<div class="list proc-table">
    <div class="proc-row head"><span>Process</span><span>Uptime</span><span>CPU</span><span>Memory</span><span></span></div>
    ${rows.map((r) => {
      const s = state.stats[r.key];
      const hist = state.history.series[r.key] || [];
      const up = r.startedAt ? Date.now() - r.startedAt : 0;
      return `<div class="proc-row${r.meta ? ' click' : ''}" ${r.meta ? `data-act="focus" data-tid="${r.meta.id}"` : ''}>
        <span class="proc-name"><span class="dot running"></span><span><b>${esc(r.label)}</b><small>${esc(r.sub)}</small></span></span>
        <span class="proc-up"><span class="bar"><i style="width:${Math.max((up / longest) * 100, 2).toFixed(1)}%"></i></span>${since(r.startedAt) || '?'}</span>
        <span class="proc-metric">${sparkline(hist, 'cpu', 1)}<span data-stat-cpu="${r.key}">${fmtPct(s?.cpu)}</span></span>
        <span class="proc-metric">${sparkline(hist, 'mem', 2)}<span data-stat-mem="${r.key}">${s ? fmtMem(s.mem) : '...'}</span></span>
        <span>${r.meta ? portLink(r.meta) : r.port ? `<span class="port">:${r.port}</span>` : ''}</span>
      </div>`;
    }).join('')}
  </div>`;
}

/** CPU and memory charts for a set of usage keys (a project), or the whole PC when keys is omitted. */
export function usageCharts(keys?: string[]): string {
  if (!keys) {
    const h = state.history.machine;
    const total = state.machine?.memTotal || h.at(-1)?.memTotal || 1;
    return `<div class="charts">
      ${lineChart({ title: 'CPU, whole PC', series: 1, max: 100, fmt: (v) => `${Math.round(v)}%`, ticks: [0, 50, 100], points: h.map((s) => ({ at: s.at, v: s.cpu })) })}
      ${lineChart({ title: 'Memory, whole PC', series: 2, max: total, fmt: fmtMem, ticks: [0, total / 2, total], points: h.map((s) => ({ at: s.at, v: s.mem })) })}
    </div>`;
  }
  const sum = sumSeries(keys);
  const peakMem = Math.max(...sum.map((s) => s.mem), 1);
  const memMax = Math.ceil(peakMem / 268435456) * 268435456; // round up to 256 MB steps
  const cpuMax = Math.max(10, Math.ceil(Math.max(...sum.map((s) => s.cpu ?? 0), 1) / 10) * 10);
  return `<div class="charts">
    ${lineChart({ title: 'CPU, this project', series: 1, max: cpuMax, fmt: (v) => `${v.toFixed(v < 10 ? 1 : 0)}%`, ticks: [0, cpuMax / 2, cpuMax], points: sum.map((s) => ({ at: s.at, v: s.cpu })) })}
    ${lineChart({ title: 'Memory, this project', series: 2, max: memMax, fmt: fmtMem, ticks: [0, memMax / 2, memMax], points: sum.map((s) => ({ at: s.at, v: s.mem })) })}
  </div>`;
}

/** Called on every 'stats' message: refresh chart blocks and numbers without rebuilding the page. */
export function drawCharts() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-usage]')) {
    const keys = el.dataset.usage === 'machine' ? undefined : processRows(el.dataset.usage).map((r) => r.key);
    el.innerHTML = usageCharts(keys);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-proc-table]')) el.innerHTML = processTable(processRows(el.dataset.procTable || undefined));
  const m = state.machine;
  for (const el of document.querySelectorAll<HTMLElement>('[data-machine]')) {
    const k = el.dataset.machine;
    el.textContent = !m ? '...' : k === 'cpu' ? fmtPct(m.cpu) : k === 'mem' ? `${(m.memUsed / 1073741824).toFixed(1)} / ${fmtMem(m.memTotal)}` : fmtDur(m.uptime * 1000);
  }
}
