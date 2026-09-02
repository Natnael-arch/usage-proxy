const { test } = require('node:test');
const assert = require('node:assert');
const { generateToken, hashToken } = require('../services/token');

test('generateToken returns a high-entropy token', () => {
  const t = generateToken();
  assert.ok(t.length >= 43); // 32 bytes base64url
  assert.notStrictEqual(generateToken(), generateToken());
});

test('hashToken returns a sha256 hex digest and differs between tokens', () => {
  const t = generateToken();
  const hash = hashToken(t);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(hash, hashToken(generateToken()));
});