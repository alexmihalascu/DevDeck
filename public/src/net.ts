// Talking to the Devdeck server: JSON API calls and the live WebSocket.
import type { ClientMsg, ServerMsg } from '../../types.ts';
import { $ } from './util.ts';

export async function api<T = any>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data as T;
}

let ws: WebSocket | null = null;
export const send = (msg: ClientMsg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

export function connect(onMessage: (msg: ServerMsg) => void) {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => { $('#offline').hidden = true; };
  // A refused socket usually means the session ended: /api/me sends us to login if so.
  ws.onclose = () => { $('#offline').hidden = false; setTimeout(() => api('GET', '/api/me').then(() => connect(onMessage), () => {}), 1000); };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data) as ServerMsg);
}
