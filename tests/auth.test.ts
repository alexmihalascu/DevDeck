import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth, parseCookies, totp, type LoginResult } from '../auth.ts';

const password = 'test-password-123';
function account() {
  const auth = createAuth({ file: ':memory:' });
  auth.createUser('tester', password);
  return { auth, uid: auth.users()[0].id };
}
function ticket(result: LoginResult) {
  assert.ok('ticket' in result);
  return result.ticket;
}

test('malformed unrelated cookies do not break session authentication', () => {
  assert.equal(parseCookies('broken=%; dd_session=valid-token').dd_session, 'valid-token');
  assert.equal(parseCookies('dd_session=%E0%A4%A').dd_session, undefined);
});

test('starting MFA setup cannot disable an already enabled second factor', () => {
  const { auth, uid } = account();
  const { secret } = auth.startMfa(uid);
  auth.confirmMfa(uid, totp(secret));
  assert.throws(() => auth.startMfa(uid), /already enabled/i);
  assert.equal(auth.users()[0].totp_enabled, true);
  const result = auth.login('127.0.0.1', 'tester', password);
  assert.ok('mfa' in result);
  assert.ok('token' in auth.loginMfa('127.0.0.1', ticket(result), totp(secret)));
});

test('password reset invalidates pending MFA login tickets as well as sessions', () => {
  const { auth, uid } = account();
  const { secret } = auth.startMfa(uid);
  auth.confirmMfa(uid, totp(secret));
  const pending = ticket(auth.login('127.0.0.1', 'tester', password));
  auth.setPassword(uid, 'replacement-password');
  assert.ok('error' in auth.loginMfa('127.0.0.1', pending, totp(secret)));
});

test('deleting and recreating an account cannot reuse its pending login tickets', () => {
  const { auth, uid } = account();
  const first = auth.startMfa(uid);
  auth.confirmMfa(uid, totp(first.secret));
  const pending = ticket(auth.login('127.0.0.1', 'tester', password));
  auth.deleteUser(uid);
  auth.createUser('replacement', password);
  const replacement = auth.startMfa(auth.users()[0].id);
  auth.confirmMfa(auth.users()[0].id, totp(replacement.secret));
  assert.ok('error' in auth.loginMfa('127.0.0.1', pending, totp(replacement.secret)));
});

test('lockout expires into a fresh attempt window', (t) => {
  const { auth } = account();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (let i = 0; i < 8; i++) auth.login('127.0.0.1', 'tester', 'incorrect');
  assert.equal((auth.login('127.0.0.1', 'tester', password) as { status: number }).status, 429);
  now += 10 * 60_000 + 1;
  assert.equal((auth.login('127.0.0.1', 'tester', 'incorrect') as { status: number }).status, 401);
  assert.ok('token' in auth.login('127.0.0.1', 'tester', password));
});

test('session revocation is scoped to its user and logout invalidates the token', () => {
  const { auth, uid } = account();
  auth.createUser('second', password);
  const login = auth.login('127.0.0.1', 'tester', password);
  assert.ok('token' in login);
  const req = { headers: { cookie: `dd_session=${login.token}` } };
  const session = auth.session(req)!;
  auth.revoke(session.tokenHash, auth.users().find((u) => u.id !== uid)!.id);
  assert.ok(auth.session(req));
  auth.logout(session.tokenHash);
  assert.equal(auth.session(req), null);
});
