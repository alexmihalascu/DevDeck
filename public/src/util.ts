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
/** One decimal under 10 %, whole numbers above: the same text on tiles, charts, chips and tooltips. */
export const fmtPct = (n: number | null | undefined) => n == null ? '...' : n === 0 ? '0%' : n < 10 ? `${n.toFixed(1)}%` : `${Math.round(n)}%`;
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
  el.innerHTML = `<i class="ph-fill ${error ? 'ph-warning-circle' : 'ph-check-circle'}"></i><span class="toast-text"></span>
    <button class="icon-btn" title="Dismiss"><i class="ph ph-x"></i></button>`;
  el.querySelector('.toast-text')!.textContent = text;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  el.querySelector('button')!.onclick = close;
  // Errors stay longer: they usually need reading.
  let timer = setTimeout(close, error ? 7000 : 4000);
  el.onpointerenter = () => clearTimeout(timer);
  el.onpointerleave = () => { timer = setTimeout(close, 2000); };
  box.append(el);
}

/**
 * Patch el's children to match html instead of replacing them, so focus, hover, scroll, running CSS animations and
 * half-typed input survive the frequent re-renders (every server message). Nodes pair up by position; a different
 * tag, or a different data-key, replaces the node.
 */
export function morph(el: Element, html: string) {
  const next = document.createElement('template');
  next.innerHTML = html;
  patchChildren(el, next.content);
}
function patchChildren(from: Node, to: Node) {
  const want = [...to.childNodes];
  let cur = from.firstChild;
  for (const n of want) {
    if (!cur) { from.appendChild(n); continue; }
    if (sameKind(cur, n)) { patchNode(cur, n); cur = cur.nextSibling; continue; }
    from.insertBefore(n, cur);
    const stale = cur;
    cur = cur.nextSibling;
    // Keep scanning from the stale node only if the next wanted node may still match it; otherwise drop it now.
    if (!want.some((w) => sameKind(stale, w))) stale.remove(); else cur = stale;
  }
  while (cur) { const n = cur.nextSibling; cur.remove(); cur = n; }
}
function sameKind(a: Node, b: Node) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a.nodeType !== 1) return true;
  return (a as Element).getAttribute('data-key') === (b as Element).getAttribute('data-key');
}
function patchNode(cur: Node, n: Node) {
  if (cur.nodeType !== 1) { if (cur.nodeValue !== n.nodeValue) cur.nodeValue = n.nodeValue; return; }
  const a = cur as HTMLElement, b = n as HTMLElement;
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  if (a instanceof HTMLTextAreaElement) return; // its text is the user's
  if (a instanceof HTMLInputElement) {
    // Properties, not attributes, are what the user sees; leave the field being edited alone.
    if (a.type === 'checkbox' || a.type === 'radio') a.checked = b.hasAttribute('checked');
    else if (document.activeElement !== a) a.value = (b as HTMLInputElement).value;
    return;
  }
  // A child list another module owns (it says so with data-own) is left as is.
  if (a.hasAttribute('data-own')) return;
  patchChildren(a, b);
}

/** Read a data-* attribute from the nearest element that has it. */
export const dataOf = (el: Element, key: string) => (el.closest(`[data-${key}]`) as HTMLElement | null)?.dataset[key.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())];
