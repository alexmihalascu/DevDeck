// Talking to the Devdeck server: JSON API calls and the live WebSocket.
import type { ClientMsg, ServerMsg } from '../../types.ts';
import { $ } from './util.ts';

export async function api<T = any>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) { location.href = '/login.html'; throw Object.assign(new Error('Signed out'), { status: 401 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data as T;
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
export const send = (msg: ClientMsg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

export function connect(onMessage: (msg: ServerMsg) => void) {
  const current = ++generation;
  clearTimeout(reconnectTimer);
  ws?.close();
  const active = () => current === generation;
  const retry = () => {
    if (!active()) return;
    reconnectTimer = setTimeout(async () => {
      try {
        await api('GET', '/api/me');
        if (active()) open();
      } catch (error) {
        // Authentication failures redirect to login; a server restart or network outage keeps retrying.
        if ((error as { status?: number }).status !== 401) retry();
      }
    }, 1000);
  };
  const open = () => {
    const socket = ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    socket.onopen = () => { if (active()) $('#offline').hidden = true; };
    socket.onclose = () => { if (active()) { $('#offline').hidden = false; retry(); } };
    socket.onmessage = (e) => { if (active()) onMessage(JSON.parse(e.data) as ServerMsg); };
  };
  open();
  return () => {
    if (!active()) return;
    generation++;
    clearTimeout(reconnectTimer);
    ws?.close();
    ws = null;
  };
}
