// Unit/integration test for POST /v1/activate (public onboarding endpoint).
//
// Uses a real in-process express app with the real activate router, stubbing
// the DB pool to avoid a live database. Covers: happy path (one-time exchange),
// invalid code, already-used code, expired code, and missing code.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const activateRouter = require('../routes/activate');
const { pool } = require('../db/connection');
const { hashToken } = require('../services/token');

let server;
let baseUrl;
let originalConnect;
let queries;

function fakeClient() {
  return {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.trim() === 'BEGIN' || sql.trim() === 'COMMIT' || sql.trim() === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('FROM activation_codes')) {
        return { rows: [currentCodeRow] };
      }
      if (sql.includes('INSERT INTO auth_tokens')) {
        return { rows: [{ id: 'at-1' }] };
      }
      if (sql.includes('UPDATE instances')) {
        const update = queries.filter(
          (q) => q.sql.includes('UPDATE instances') && q.sql.includes('fingerprint_hash')
        ).pop();
        lastFingerprintUpdate = update ? update.params : null;
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
}

let currentCodeRow;
let lastFingerprintUpdate;
function stubPool() {
  queries = [];
  lastFingerprintUpdate = null;
  originalConnect = pool.connect;
  pool.connect = async () => fakeClient();
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1', activateRouter);
  return app;
}

function postActivate(payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/activate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(payload || {}));
    req.end();
  });
}

before(async () => {
  stubPool();
  const app = buildApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => {
  if (server) server.close();
  if (originalConnect) pool.connect = originalConnect;
});

test('happy path: exchange a valid code for a token exactly once', async () => {
  queries = [];
  currentCodeRow = {
    id: 'ac-1',
    instance_id: 'i-1',
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
    used_at: null,
  };

  const res = await postActivate({ activation_code: 'valid-code-123' });

  assert.equal(res.status, 200);
  assert.match(res.body.token, /^[A-Za-z0-9_-]{43}$/);

  const inserts = queries.find((q) => q.sql.includes('INSERT INTO auth_tokens'));
  assert.ok(inserts, 'expected an auth_tokens INSERT');
  assert.equal(inserts.params[0], 'i-1');
  assert.equal(inserts.params[1], hashToken(res.body.token));

  const update = queries.find((q) => q.sql.includes('UPDATE activation_codes'));
  assert.ok(update, 'expected a used_at UPDATE');
  assert.equal(update.params[0], 'at-1');
  assert.equal(update.params[1], 'ac-1');

  const hasLock = queries.some((q) => q.sql.includes('FOR UPDATE'));
  assert.ok(hasLock, 'expected the code row to be locked');
});

test('invalid code returns 404 invalid_code', async () => {
  queries = [];
  currentCodeRow = undefined;

  const res = await postActivate({ activation_code: 'nope' });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'invalid_code');
});

test('already-used code returns 409 code_already_used', async () => {
  queries = [];
  currentCodeRow = {
    id: 'ac-2',
    instance_id: 'i-2',
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
    used_at: new Date().toISOString(),
  };

  const res = await postActivate({ activation_code: 'used-code' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'code_already_used');
  const inserts = queries.filter((q) => q.sql.includes('INSERT INTO auth_tokens'));
  assert.equal(inserts.length, 0, 'must not mint a token for a used code');
});

test('expired code returns 410 code_expired', async () => {
  queries = [];
  currentCodeRow = {
    id: 'ac-3',
    instance_id: 'i-3',
    expires_at: new Date(Date.now() - 3600e3).toISOString(),
    used_at: null,
  };

  const res = await postActivate({ activation_code: 'old-code' });

  assert.equal(res.status, 410);
  assert.equal(res.body.error, 'code_expired');
});

test('missing code returns 400 missing_activation_code', async () => {
  queries = [];
  currentCodeRow = {
    id: 'ac-4',
    instance_id: 'i-4',
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
    used_at: null,
  };

  const res = await postActivate({});

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'missing_activation_code');
});

test('fingerprint is bound to the instance on successful activation', async () => {
  queries = [];
  lastFingerprintUpdate = null;
  currentCodeRow = {
    id: 'ac-5',
    instance_id: 'i-5',
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
    used_at: null,
  };

  const fp = 'a'.repeat(64);
  const res = await postActivate({ activation_code: 'code-with-fp', fingerprint: fp });

  assert.equal(res.status, 200);
  assert.equal(res.body.fingerprint_bound, true);
  assert.ok(lastFingerprintUpdate, 'expected an instances fingerprint UPDATE');
  assert.equal(lastFingerprintUpdate[0], fp);
  assert.equal(lastFingerprintUpdate[1], 'i-5');

  const verify = queries.some((q) => q.sql.includes('UPDATE instances'));
  assert.ok(verify, 'expected an UPDATE instances query');
});

test('no fingerprint -> token minted, no instance binding, allowed (legacy)', async () => {
  queries = [];
  lastFingerprintUpdate = null;
  currentCodeRow = {
    id: 'ac-6',
    instance_id: 'i-6',
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
    used_at: null,
  };

  const res = await postActivate({ activation_code: 'legacy-code' });

  assert.equal(res.status, 200);
  assert.equal(res.body.fingerprint_bound, false);
  assert.equal(lastFingerprintUpdate, null, 'must not bind when no fingerprint sent');
});

test('malformed fingerprint returns 400 invalid_fingerprint', async () => {
  queries = [];
  currentCodeRow = {
    id: 'ac-7',
    instance_id: 'i-7',
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
    used_at: null,
  };

  const res = await postActivate({ activation_code: 'bad-fp-code', fingerprint: 'not-a-hash' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_fingerprint');
  const inserts = queries.filter((q) => q.sql.includes('INSERT INTO auth_tokens'));
  assert.equal(inserts.length, 0, 'must not mint a token for a malformed fingerprint');
});