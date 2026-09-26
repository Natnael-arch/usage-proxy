// Unit tests for machine-fingerprint enforcement in middleware/auth.js.
//
// Builds a minimal in-process express app with the REAL authenticate
// middleware and a stubbed pool, then asserts the fingerprint semantics:
//   - matching fingerprint            -> passes, no fingerprint error
//   - header absent                   -> soft allow (rollout), warned
//   - stored hash absent              -> soft allow (legacy token), warned
//   - mismatch + FINGERPRINT_ENFORCE=soft (default) -> ALLOW (grace window)
//   - mismatch + FINGERPRINT_ENFORCE=hard          -> 403 instance_mismatch
//   - malformed header                -> ignored (warn), still allowed
//   - revoked/expired token still rejected regardless of fingerprint
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { authenticate } = require('../middleware/auth');
const { pool } = require('../db/connection');
const { hashToken } = require('../services/token');

let server;
let baseUrl;
let originalQuery;
let lastInstanceFp;
let instanceStatus = 'active';
let customerStatus = 'active';
let revokedAt = null;
let expiresAt = null;
let enforceMode = 'soft';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1', authenticate, (req, res) => {
    res.json({ ok: true, instance_id: req.instance_id });
  });
  return app;
}

function stubPool() {
  originalQuery = pool.query;
  pool.query = async function (sql, params = []) {
    if (sql.includes('FROM auth_tokens')) {
      return {
        rows: [
          {
            token_id: 't1',
            token_hash: hashToken('test-token'),
            instance_id: 'i1',
            instance_status: instanceStatus,
            customer_status: customerStatus,
            fingerprint_hash: lastInstanceFp,
            revoked_at: revokedAt,
            expires_at: expiresAt,
          },
        ],
      };
    }
    if (sql.includes('UPDATE instances')) {
      return { rows: [] };
    }
    return { rows: [] };
  };
}

function requestFp(headerValue) {
  const headers = { Authorization: 'Bearer test-token' };
  if (headerValue !== undefined) headers['X-Instance-Fingerprint'] = headerValue;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/v1/echo`,
      { method: 'POST', headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const FP = 'a'.repeat(64);
const OTHER_FP = 'b'.repeat(64);

before(async () => {
  stubPool();
  const app = buildApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (originalQuery) pool.query = originalQuery;
});

function reset() {
  instanceStatus = 'active';
  customerStatus = 'active';
  revokedAt = null;
  expiresAt = null;
  enforceMode = 'soft';
  lastInstanceFp = FP;
  process.env.FINGERPRINT_ENFORCE = 'soft';
}

test('matching fingerprint is accepted', async () => {
  reset();
  lastInstanceFp = FP;
  const res = await requestFp(FP);
  assert.equal(res.status, 200);
});

test('absent fingerprint header is allowed in soft mode (rollout)', async () => {
  reset();
  const res = await requestFp(undefined);
  assert.equal(res.status, 200);
});

test('absent fingerprint header is allowed even in hard mode', async () => {
  reset();
  process.env.FINGERPRINT_ENFORCE = 'hard';
  const res = await requestFp(undefined);
  assert.equal(res.status, 200, 'absent header must never hard-fail (legacy clients)');
});

test('instance with no stored fingerprint binds-future and allows', async () => {
  reset();
  lastInstanceFp = null;
  const res = await requestFp(FP);
  assert.equal(res.status, 200);
});

test('mismatch is allowed during soft-enforcement grace window', async () => {
  reset();
  const res = await requestFp(OTHER_FP);
  assert.equal(res.status, 200, 'soft mode must allow during grace window');
});

test('mismatch is rejected (403 instance_mismatch) in hard mode', async () => {
  reset();
  process.env.FINGERPRINT_ENFORCE = 'hard';
  const res = await requestFp(OTHER_FP);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'instance_mismatch');
});

test('malformed fingerprint header is ignored (warn), still allowed', async () => {
  reset();
  const res = await requestFp('not-a-sha256-hash');
  assert.equal(res.status, 200);
});

test('fingerprint checks never shadow token validity', async () => {
  reset();
  revokedAt = new Date().toISOString();
  const res = await requestFp(FP);
  assert.equal(res.status, 401);
  assert.match(res.body.error, /revoked/i);
});