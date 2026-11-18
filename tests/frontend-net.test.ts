import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { connect, send } from '../public/src/net.ts';

class Socket {
  static OPEN = 1;
  static sockets: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: string }) => void;
  sent: string[] = [];
  url: string;
  constructor(url: string) { this.url = url; Socket.sockets.push(this); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { this.sent.push(data); }
}

function environment(t: TestContext) {
  const offline = { hidden: true };
  const location = { host: 'localhost:4321', protocol: 'http:', href: 'http://localhost:4321/' };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ document: { querySelector: () => offline }, location, WebSocket: Socket })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  Socket.sockets = [];
  t.after(() => {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return { offline, location };
}

test('socket reconnect keeps retrying through a longer server outage', async (t) => {
  const { offline } = environment(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++requests < 3) throw new TypeError('Network unavailable');
    return new Response('{}');
  });
  const messages: unknown[] = [];
  const disconnect = connect((msg) => messages.push(msg));
  try {
    Socket.sockets[0].close();
    assert.equal(offline.hidden, false);
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); await setImmediate(); }
    assert.equal(requests, 3);
    assert.equal(Socket.sockets.length, 2);
    Socket.sockets[1].onopen?.();
    assert.equal(offline.hidden, true);
    Socket.sockets[1].onmessage?.({ data: '{"t":"error","message":"Example failure"}' });
    assert.deepEqual(messages, [{ t: 'error', message: 'Example failure' }]);
    send({ t: 'restartService', serviceId: 'svc' });
    assert.deepEqual(Socket.sockets[1].sent, ['{"t":"restartService","serviceId":"svc"}']);
  } finally { disconnect(); }
});

test('expired authentication redirects to login and stops reconnect attempts', async (t) => {
  const { location } = environment(t);
  const request = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
  const disconnect = connect(() => {});
  try {
    Socket.sockets[0].close();
    t.mock.timers.tick(1000); await setImmediate();
    assert.equal(location.href, '/login.html');
    t.mock.timers.tick(5000); await setImmediate();
    assert.equal(request.mock.callCount(), 1);
    assert.equal(Socket.sockets.length, 1);
  } finally { disconnect(); }
});

test('replacing a connection cancels stale retries and stale messages', async (t) => {
  environment(t);
  const request = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  let oldMessages = 0;
  const oldDisconnect = connect(() => { oldMessages++; });
  const old = Socket.sockets[0];
  old.close();
  const disconnect = connect(() => {});
  try {
    old.onmessage?.({ data: '{"t":"config"}' });
    oldDisconnect();
    t.mock.timers.tick(5000); await setImmediate();
    assert.equal(request.mock.callCount(), 0);
    assert.equal(Socket.sockets.length, 2);
    assert.equal(Socket.sockets[1].readyState, 1);
    assert.equal(oldMessages, 0);
  } finally { disconnect(); }
});

