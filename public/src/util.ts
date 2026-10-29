// Small DOM and formatting helpers shared by every view.

export function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
}
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];

/** Escape for HTML text and attribute values. Every string from the server goes through this. */
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const store = {
  get<T>(k: string, d: T): T { try { return (JSON.parse(localStorage.getItem(k) as string) as T) ?? d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h`;
};
export const ago = (ms: number | null | undefined) => ms ? `${fmtDur(Date.now() - ms).split(' ')[0]} ago` : 'never';
export const fmtMem = (b: number) => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`;
export const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
export const fmtPct = (n: number | null | undefined) => n == null ? '...' : `${n.toFixed(1)}%`;
export const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** Toasts stack in one live region, so screen readers announce them and two at once don't overlap. */
export function toast(text: string, error = false) {
  let box = document.querySelector('.toasts');
  if (!box) {
    box = Object.assign(document.createElement('div'), { className: 'toasts' });
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast${error ? ' err' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  el.textContent = text;
  box.append(el);
  setTimeout(() => el.remove(), 4000);
}

/** Read a data-* attribute from the nearest element that has it. */
export const dataOf = (el: Element, key: string) => (el.closest(`[data-${key}]`) as HTMLElement | null)?.dataset[key.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())];
