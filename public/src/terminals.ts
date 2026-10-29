// xterm.js panes: one per server terminal, kept alive while hidden so output never gets lost.
import type { TermMeta } from '../../types.ts';
import { $ } from './util.ts';
import { send } from './net.ts';
import { state, persist, termFor } from './state.ts';
import { render } from './render.ts';

export function xtermTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return { background: v('--term-bg'), foreground: v('--term-fg'), cursor: v('--text'), cursorAccent: v('--term-bg'), selectionBackground: v('--term-sel') };
}

export function addTerm(meta: TermMeta, buf: string) {
  const el = document.createElement('div');
  el.className = 'pane';
  el.innerHTML = '<div class="pane-title"></div><div class="pane-body"></div>';
  (el.querySelector('.pane-title') as HTMLElement).onclick = () => focusTerm(state.terms.get(meta.id)!.meta);
  $('#stage').append(el);

  const term = new Terminal({ fontFamily: '"Geist Mono Variable", Consolas, monospace', fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 10000, theme: xtermTheme() });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector('.pane-body') as HTMLElement);
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    // Ctrl+C copies when text is selected, otherwise it is a real ^C. Ctrl+V is left to the browser's paste.
    if (e.key === 'c' && term.hasSelection()) { navigator.clipboard?.writeText(term.getSelection()); term.clearSelection(); return false; }
    return e.key !== 'v';
  });
  term.onData((data: string) => send({ t: 'input', id: meta.id, data }));
  term.write(buf);
  state.terms.set(meta.id, { meta, term, fit, el });
}

export function removeTerm(id: string) {
  const t = state.terms.get(id);
  if (!t) return;
  t.term.dispose();
  t.el.remove();
  state.terms.delete(id);
}

export function focusTerm(meta: TermMeta) {
  state.selected = meta.projectId;
  state.active[meta.projectId] = meta.id;
  persist();
  render();
  state.terms.get(meta.id)?.term.focus();
}

function fitVisible() {
  for (const { meta, term, fit, el } of state.terms.values()) {
    if (!el.classList.contains('visible')) continue;
    const { cols, rows } = term;
    try { fit.fit(); } catch { continue; }
    if (term.cols !== cols || term.rows !== rows || !meta.sized) {
      meta.sized = true;
      send({ t: 'resize', id: meta.id, cols: term.cols, rows: term.rows });
    }
  }
}
let fitQueued = false;
export const queueFit = () => { if (!fitQueued) { fitQueued = true; requestAnimationFrame(() => { fitQueued = false; fitVisible(); }); } };

export function runScript(appId: string, script: string) {
  const existing = termFor(appId, script);
  if (existing) {
    if (existing.meta.status !== 'running') send({ t: 'restart', id: existing.meta.id });
    return focusTerm(existing.meta);
  }
  state.pendingFocus = `${appId}\n${script}`;
  send({ t: 'spawn', appId, script });
}

export function openShell(appId: string) {
  state.pendingFocus = `${appId}\n`;
  send({ t: 'spawn', appId, script: null });
}
