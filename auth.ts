import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import type { SessionRow, UserRow } from './types.ts';

// Accounts + sessions in SQLite, passwords scrypt-hashed, optional TOTP (RFC 6238) second factor.
const SESSION_DAYS = 30;
const MAX_FAILS = 8;
const LOCK_MS = 10 * 60_000;
const MFA_TICKET_MS = 5 * 60_000;
type HttpError = Error & { status: number };
const fail = (message: string, status = 400): HttpError => Object.assign(new Error(message), { status });

interface Hashed { salt: string; hash: string }
interface UserRecord extends Hashed { id: number; username: string; totp_secret: string | null; totp_enabled: number; created_at: number; last_login: number | null }
interface SessionRecord { token_hash: string; user_id: number; created_at: number; last_seen: number; ip: string | null; agent: string | null; username: string }
export interface Session { userId: number; user: string; tokenHash: string }
export type LoginResult = { token: string } | { mfa: true; ticket: string } | { error: string; status: number };

export const hashPassword = (password: string, salt = crypto.randomBytes(16).toString('hex')): Hashed =>
  ({ salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') });

export const checkPassword = (password: unknown, { salt, hash }: Hashed): boolean => {
  const got = crypto.scryptSync(String(password), salt, 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

// ---------- TOTP ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32 = (buf: Buffer): string => {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
};
const unbase32 = (s: string): Buffer => {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2)));
};
export function totp(secret: string, time = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// One step of clock drift either way.
export const verifyTotp = (secret: string, code: unknown, now = Date.now()): boolean =>
  /^\d{6}$/.test(String(code)) && [-1, 0, 1].some((d) => totp(secret, now + d * 30_000) === String(code));

export const isLoopback = (addr = ''): boolean => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
export const parseCookies = (header = ''): Record<string, string> => Object.fromEntries(header.split(';').map((c) => {
  const i = c.indexOf('=');
  return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
}));
// Real adapters first (Wi-Fi, then Ethernet); virtual ones (VMware, Hyper-V, WSL) last since nobody browses to them.
const VIRTUAL_RE = /vmware|virtualbox|vethernet|hyper-v|wsl|docker|loopback/i;
const WIFI_RE = /wi-?fi|wlan/i;
export const lanAddresses = (): string[] => Object.entries(os.networkInterfaces())
  .flatMap(([name, list = []]) => list.filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ name, ip: i.address })))
  .sort((a, b) => (Number(VIRTUAL_RE.test(a.name)) - Number(VIRTUAL_RE.test(b.name))) || (Number(WIFI_RE.test(b.name)) - Number(WIFI_RE.test(a.name))))
  .map((i) => i.ip);

export function createAuth({ file }: { file: string }) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      salt TEXT NOT NULL, hash TEXT NOT NULL,
      totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, last_login INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT, agent TEXT
    );
    PRAGMA foreign_keys = ON;
  `);
  // Only a hash of the token is stored: a copied database file cannot be used to log in.
  const tokenHash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
  const fails = new Map<string, { n: number; until: number }>();
  const tickets = new Map<string, { userId: number; ip: string; at: number }>();
  const userByName = (name: string) => db.prepare('SELECT * FROM users WHERE username = ?').get(name) as UserRecord | undefined;
  const userById = (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRecord | undefined;
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

  function newSession(user: UserRecord, ip: string, agent: unknown): { token: string } {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, ip, agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tokenHash(token), user.id, now, now, ip, String(agent || '').slice(0, 200));
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now, user.id);
    return { token };
  }
  function failed(ip: string) {
    const f = fails.get(ip);
    const n = (f && f.until > Date.now() ? 0 : f?.n || 0) + 1;
    fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
  }
  const locked = (ip: string) => {
    const f = fails.get(ip);
    return f && f.until > Date.now() ? `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} min.` : null;
  };

  return {
    hasUsers: () => count() > 0,
    session(req: Pick<IncomingMessage, 'headers'>): Session | null {
      const t = parseCookies(req.headers.cookie).dd_session;
      if (!t) return null;
      const s = db.prepare('SELECT s.*, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE token_hash = ?').get(tokenHash(t)) as SessionRecord | undefined;
      if (!s) return null;
      if (Date.now() - s.created_at > SESSION_DAYS * 864e5) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash); return null; }
      if (Date.now() - s.last_seen > 60_000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(Date.now(), s.token_hash);
      return { userId: s.user_id, user: s.username, tokenHash: s.token_hash };
    },
    // Step 1: password. Returns a session, or an MFA ticket when the account has TOTP on.
    login(ip: string, username: unknown, password: unknown, agent?: unknown): LoginResult {
      const lock = locked(ip);
      if (lock) return { error: lock, status: 429 };
      const u = userByName(String(username || ''));
      // Hash anyway for unknown users so timing does not reveal which names exist.
      const ok = u ? checkPassword(password, u) : (checkPassword(password, hashPassword('x')), false);
      if (!u || !ok) { failed(ip); return { error: 'Wrong user or password.', status: 401 }; }
      if (u.totp_enabled) {
        const ticket = crypto.randomBytes(24).toString('hex');
        tickets.set(ticket, { userId: u.id, ip, at: Date.now() });
        return { mfa: true, ticket };
      }
      fails.delete(ip);
      return newSession(u, ip, agent);
    },
    // Step 2: the 6-digit code.
    loginMfa(ip: string, ticket: unknown, code: unknown, agent?: unknown): LoginResult {
      const lock = locked(ip);
      if (lock) return { error: lock, status: 429 };
      const t = tickets.get(String(ticket));
      if (!t || t.ip !== ip || Date.now() - t.at > MFA_TICKET_MS) { tickets.delete(String(ticket)); return { error: 'Login expired. Start again.', status: 401 }; }
      const u = userById(t.userId);
      if (!u?.totp_secret || !verifyTotp(u.totp_secret, code)) { failed(ip); return { error: 'Wrong code.', status: 401 }; }
      tickets.delete(String(ticket));
      fails.delete(ip);
      return newSession(u, ip, agent);
    },
    logout(hash: string) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash); },
    cookie: (token: string, maxAge = SESSION_DAYS * 86400) => `dd_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,

    // ---------- account management ----------
    users: (): UserRow[] => (db.prepare('SELECT id, username, totp_enabled, created_at, last_login FROM users ORDER BY username').all() as unknown as (Omit<UserRow, 'totp_enabled'> & { totp_enabled: number })[])
      .map((u) => ({ ...u, totp_enabled: !!u.totp_enabled })),
    createUser(username: unknown, password: unknown) {
      const name = String(username || '').trim();
      if (!/^[\w.@-]{2,40}$/.test(name)) throw fail('User name: 2-40 letters, digits, . _ - @');
      if (String(password || '').length < 8) throw fail('Password: at least 8 characters.');
      if (userByName(name)) throw fail('That user already exists.');
      const { salt, hash } = hashPassword(String(password));
      db.prepare('INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)').run(name, salt, hash, Date.now());
    },
    setPassword(userId: number, password: unknown) {
      if (String(password || '').length < 8) throw fail('Password: at least 8 characters.');
      const { salt, hash } = hashPassword(String(password));
      db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, userId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); // new password signs everything out
    },
    deleteUser(userId: number) { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); db.prepare('DELETE FROM users WHERE id = ?').run(userId); },
    // MFA setup: a pending secret becomes active only after one correct code.
    startMfa(userId: number) {
      const u = userById(userId);
      if (!u) throw fail('No such user', 404);
      const secret = base32(crypto.randomBytes(20));
      db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, userId);
      return { secret, uri: `otpauth://totp/Devdeck:${encodeURIComponent(u.username)}?secret=${secret}&issuer=Devdeck&digits=6&period=30` };
    },
    confirmMfa(userId: number, code: unknown) {
      const u = userById(userId);
      if (!u?.totp_secret || !verifyTotp(u.totp_secret, code)) throw fail('Wrong code. Check the time on your phone and try again.');
      db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(userId);
    },
    disableMfa(userId: number) { db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(userId); },
    sessions: (userId: number) => db.prepare('SELECT token_hash AS id, created_at, last_seen, ip, agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(userId) as unknown as SessionRow[],
    allSessions: () => db.prepare('SELECT s.token_hash AS id, s.created_at, s.last_seen, s.ip, s.agent, u.username FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.last_seen DESC').all() as unknown as SessionRow[],
    revoke(id: string, userId: number | null = null) {
      if (userId == null) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(id);
      else db.prepare('DELETE FROM sessions WHERE token_hash = ? AND user_id = ?').run(id, userId);
    },
  };
}
export type Auth = ReturnType<typeof createAuth>;

// Locked out (lost phone, forgot password)? On the host PC:  npm run reset -- <user> <new password>
if (process.argv[1]?.endsWith('auth.ts') && process.argv[2] === '--reset') {
  const [user, password] = process.argv.slice(3);
  const a = createAuth({ file: path.join(import.meta.dirname, 'data', 'devdeck.db') });
  const u = a.users().find((x) => x.username.toLowerCase() === String(user).toLowerCase());
  if (!u || !password) {
    console.log(u ? 'Usage: npm run reset -- <user> <new password>' : `No user "${user}". Users: ${a.users().map((x) => x.username).join(', ') || 'none'}`);
    process.exit(1);
  }
  a.setPassword(u.id, password);
  a.disableMfa(u.id);
  console.log(`Password for ${u.username} changed, MFA turned off, all devices signed out.`);
}

if (process.argv[1]?.endsWith('auth.ts') && process.argv.includes('--test')) {
  // RFC 6238 test vector (SHA1, secret "12345678901234567890", T=59s -> 94287082, last 6 digits)
  const rfc = base32(Buffer.from('12345678901234567890'));
  assert.equal(totp(rfc, 59_000), '287082');
  assert.equal(totp(rfc, 1111111109_000), '081804');
  assert.ok(verifyTotp(rfc, totp(rfc, 1111111109_000 - 30_000), 1111111109_000), 'one step of drift accepted');
  assert.ok(!verifyTotp(rfc, '000000', 59_000));

  const a = createAuth({ file: ':memory:' });
  const tokenOf = (r: LoginResult) => ('token' in r ? r.token : '');
  assert.equal(a.hasUsers(), false);
  a.createUser('alex', 'password1');
  assert.throws(() => a.createUser('ALEX', 'password1'), /already exists/);
  assert.throws(() => a.createUser('bob', 'short'), /8 characters/);
  assert.equal((a.login('1.1.1.1', 'alex', 'nope') as { status: number }).status, 401);
  const token = tokenOf(a.login('1.1.1.1', 'alex', 'password1', 'test'));
  assert.equal(a.session({ headers: { cookie: `dd_session=${token}` } })?.user, 'alex');
  assert.equal(a.session({ headers: { cookie: 'dd_session=forged' } }), null);

  const uid = a.users()[0].id;
  const { secret } = a.startMfa(uid);
  assert.throws(() => a.confirmMfa(uid, '000000'), /Wrong code/);
  a.confirmMfa(uid, totp(secret));
  const step1 = a.login('1.1.1.1', 'alex', 'password1');
  assert.ok('mfa' in step1 && !('token' in step1), 'password alone is not enough with MFA on');
  const ticket = 'ticket' in step1 ? step1.ticket : '';
  assert.equal((a.loginMfa('9.9.9.9', ticket, totp(secret)) as { status: number }).status, 401, 'ticket bound to IP');
  assert.equal((a.loginMfa('1.1.1.1', ticket, totp(secret)) as { status: number }).status, 401, 'a ticket tried from another IP is burned');
  const step1b = a.login('1.1.1.1', 'alex', 'password1');
  const ticketB = 'ticket' in step1b ? step1b.ticket : '';
  assert.ok(tokenOf(a.loginMfa('1.1.1.1', ticketB, totp(secret))));
  assert.equal((a.loginMfa('1.1.1.1', ticketB, totp(secret)) as { status: number }).status, 401, 'ticket single use');

  for (let i = 0; i < MAX_FAILS; i++) a.login('2.2.2.2', 'alex', 'bad');
  assert.equal((a.login('2.2.2.2', 'alex', 'password1') as { status: number }).status, 429);

  assert.equal(a.sessions(uid).length, 2);
  a.setPassword(uid, 'password2');
  assert.equal(a.session({ headers: { cookie: `dd_session=${token}` } }), null, 'password change signs out');
  console.log('auth.ts: all checks passed');
}
