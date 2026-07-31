/** phone-auth.test.js — plain node, no framework. */
'use strict';
const assert = require('assert');
const a = require('./phone-auth');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); failed++; }
}

console.log('\nPhone auth\n');

// ---- normalizePhone ----
test('local 0-prefix normalises to +263', () => {
  assert.strictEqual(a.normalizePhone('0771234567'), '+263771234567');
});
test('263-prefix normalises', () => {
  assert.strictEqual(a.normalizePhone('263771234567'), '+263771234567');
});
test('+263 passes through', () => {
  assert.strictEqual(a.normalizePhone('+263771234567'), '+263771234567');
});
test('bare 9-digit normalises', () => {
  assert.strictEqual(a.normalizePhone('771234567'), '+263771234567');
});
test('spaces and dashes are stripped', () => {
  assert.strictEqual(a.normalizePhone('077 123 4567'), '+263771234567');
  assert.strictEqual(a.normalizePhone('077-123-4567'), '+263771234567');
});
test('non-mobile / junk returns null', () => {
  assert.strictEqual(a.normalizePhone('12345'), null);
  assert.strictEqual(a.normalizePhone('hello'), null);
  assert.strictEqual(a.normalizePhone(''), null);
  assert.strictEqual(a.normalizePhone(null), null);
});
test('landline-style (not starting 7) returns null', () => {
  assert.strictEqual(a.normalizePhone('0242123456'), null);
});

// ---- generateCode ----
test('code is always 6 digits', () => {
  for (let i = 0; i < 200; i++) {
    const c = a.generateCode();
    assert.ok(/^\d{6}$/.test(c), `bad code: ${c}`);
  }
});

// ---- verifyCode ----
const HOUR = 3600_000;
function rec(code, over = {}) {
  return {
    code_hash: a.hashCode(code),
    attempts: 0,
    expires_at: new Date(Date.now() + HOUR).toISOString(),
    consumed_at: null,
    ...over,
  };
}

test('correct code verifies', () => {
  assert.deepStrictEqual(a.verifyCode(rec('123456'), '123456'), { ok: true, reason: null });
});
test('wrong code rejected', () => {
  assert.strictEqual(a.verifyCode(rec('123456'), '000000').reason, 'code_incorrect');
});
test('missing record rejected', () => {
  assert.strictEqual(a.verifyCode(null, '123456').reason, 'no_code_found');
});
test('expired code rejected', () => {
  const r = rec('123456', { expires_at: new Date(Date.now() - HOUR).toISOString() });
  assert.strictEqual(a.verifyCode(r, '123456').reason, 'code_expired');
});
test('already-used code rejected', () => {
  const r = rec('123456', { consumed_at: new Date().toISOString() });
  assert.strictEqual(a.verifyCode(r, '123456').reason, 'code_already_used');
});
test('too many attempts rejected even if code right', () => {
  const r = rec('123456', { attempts: 5 });
  assert.strictEqual(a.verifyCode(r, '123456').reason, 'too_many_attempts');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);