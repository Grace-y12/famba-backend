/**
 * tokens.test.js — run AFTER `npm install` (needs jsonwebtoken).
 * Set a dummy secret for the test run.
 */
'use strict';
process.env.JWT_SECRET = 'test_secret_at_least_32_characters_long_xxxx';

const assert = require('assert');
const t = require('./tokens');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); failed++; }
}

console.log('\nTokens (JWT)\n');

test('issued token verifies and carries the user id + role', () => {
  const tok = t.issueToken('user-123', 'rider');
  const r = t.verifyToken(tok);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.payload.sub, 'user-123');
  assert.strictEqual(r.payload.role, 'rider');
});

test('garbage token is invalid', () => {
  const r = t.verifyToken('not.a.real.token');
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'invalid');
});

test('empty/missing token reported as no_token', () => {
  assert.strictEqual(t.verifyToken('').reason, 'no_token');
  assert.strictEqual(t.verifyToken(null).reason, 'no_token');
});

test('token signed with a DIFFERENT secret is rejected', () => {
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ sub: 'x', role: 'rider' }, 'some_other_secret_value_32_chars_min!!', { algorithm: 'HS256' });
  assert.strictEqual(t.verifyToken(forged).valid, false);
});

test('"none"-algorithm forgery is rejected (algo pinning works)', () => {
  const jwt = require('jsonwebtoken');
  // Attacker tries an unsigned token with alg=none.
  const evil = jwt.sign({ sub: 'attacker', role: 'driver' }, '', { algorithm: 'none' });
  assert.strictEqual(t.verifyToken(evil).valid, false);
});

// --- middleware ---
function mockRes() {
  return { code: null, body: null,
    status(c){ this.code=c; return this; },
    json(b){ this.body=b; return this; } };
}

test('requireAuth passes a valid Bearer token and sets req.user', () => {
  const tok = t.issueToken('user-9', 'driver');
  const req = { headers: { authorization: 'Bearer ' + tok } };
  const res = mockRes();
  let called = false;
  t.requireAuth(req, res, () => { called = true; });
  assert.strictEqual(called, true);
  assert.strictEqual(req.user.id, 'user-9');
  assert.strictEqual(req.user.role, 'driver');
});

test('requireAuth blocks a missing token with 401', () => {
  const req = { headers: {} };
  const res = mockRes();
  let called = false;
  t.requireAuth(req, res, () => { called = true; });
  assert.strictEqual(called, false);
  assert.strictEqual(res.code, 401);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
