// Streaming integration test for POST /v1/chat/completions.
//
// Verifies the SSE passthrough end-to-end without touching the network or a
// real database:
//   - global fetch is stubbed to answer upstream SSE chunks (content delta,
//     final usage chunk, [DONE])
//   - the DB pool is stubbed to simulate auth lookup, balance check, pricing
//     lookup, usage_logs insert, and ledger deduction
//   - a real local HTTP request is made against an in-process express app that
//     uses the real middleware + route
//
// Assertions cover: SSE framing ([DONE] + usage chunk forwarded), usage/cost
// extraction from the final chunk, one success row in usage_logs, and the
// matching balance deduction.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { authenticate } = require('../middleware/auth');
const { checkBalance } = require('../middleware/balanceCheck');
const chatCompletionsRouter = require('../routes/chatCompletions');
const { pool } = require('../db/connection');

let server;
let baseUrl;
let realFetch;
let originalQuery;
let usageLogInsert = [];
let ledgerInserts = [];
let pricingRate = {
  id: 'c7111111-1111-4111-8111-111111111111',
  input_cost_per_1k: '0.000220',
  output_cost_per_1k: '0.000660',
  your_margin_pct: '0',
};

// Minimal in-process app mirroring server.js wiring (no migrations/listen).
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/v1', authenticate, checkBalance, chatCompletionsRouter);
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
            instance_id: 'i1',
            customer_id: 'c1',
            instance_status: 'active',
            customer_status: 'active',
            expires_at: null,
            revoked_at: null,
          },
        ],
      };
    }
    if (sql.includes('UPDATE instances SET last_seen_at')) {
      return { rows: [] };
    }
    if (sql.includes('SUM(amount)')) {
      return { rows: [{ balance: '5.00' }] };
    }
    if (sql.includes('FROM pricing_rates')) {
      return { rows: [pricingRate] };
    }
    if (sql.includes('INSERT INTO usage_logs')) {
      usageLogInsert.push(params);
      return { rows: [{ id: 'ul1' }] };
    }
    if (sql.includes('INSERT INTO ledger_entries')) {
      ledgerInserts.push(params);
      return { rows: [{ id: 'le1' }] };
    }
    return { rows: [] };
  };
}

// Build SSE bytes representing DeepSeek's streamed response.
function sseUpstreamBody() {
  const encoder = new TextEncoder();
  const nonce = Math.floor(Math.random() * 1e6);
  const blocks = [
    `data: {"id":"chatcmpl-${nonce}","object":"chat.completion.chunk","created":0,"model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-${nonce}","object":"chat.completion.chunk","created":0,"model":"deepseek-flash","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-${nonce}","object":"chat.completion.chunk","created":0,"model":"deepseek-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":24,"completion_tokens":39,"total_tokens":63}}\n\n`,
    `data: [DONE]\n\n`,
  ];
  return new ReadableStream({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block));
      }
      controller.close();
    },
  });
}

function stubFetch() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(sseUpstreamBody(), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

function sseRequest(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: raw })
        );
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify({
      model: 'deepseek-flash',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Hi' }],
    }));
    req.end();
  });
}

before(async () => {
  stubPool();
  stubFetch();
  const app = buildApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
});

after(() => {
  if (server) server.close();
  if (originalQuery) pool.query = originalQuery;
  if (realFetch) globalThis.fetch = realFetch;
});

test('streaming request: SSE passthrough + usage/cost + usage_logs/balance', async () => {
  const res = await sseRequest(baseUrl);

  assert.strictEqual(res.status, 200);
  assert.ok(res.headers['content-type'].startsWith('text/event-stream'));

  // SSE framing must be intact: [DONE] terminator and the include_usage chunk.
  assert.match(res.body, /data: \[DONE\]/);
  assert.match(res.body, /"prompt_tokens":24/);
  assert.match(res.body, /"completion_tokens":39/);
  assert.match(res.body, /"model":"deepseek-flash"/);

  // One usage_logs success row with the usage from the final chunk.
  assert.strictEqual(usageLogInsert.length, 1);
  const [logParams] = usageLogInsert;
  assert.strictEqual(logParams[0], 'c1');          // customer_id
  assert.strictEqual(logParams[1], 'i1');          // instance_id
  assert.strictEqual(logParams[2], 'deepseek');    // provider
  assert.strictEqual(logParams[3], 'deepseek-flash'); // route
  assert.strictEqual(logParams[4], pricingRate.id);     // pricing_rate_id
  assert.strictEqual(logParams[5], 24);            // input_tokens
  assert.strictEqual(logParams[6], 39);            // output_tokens
  assert.ok(Number(logParams[7]) > 0, `expected cost > 0, got ${logParams[7]}`);
  assert.strictEqual(logParams[9], 'success');     // status

  // Ledger deduction: amount equals -cost, linked to the usage log row.
  const cost = Number(logParams[7]);
  const expectedDeduct = Number((-(24 / 1000 * 0.000220 + 39 / 1000 * 0.000660)).toFixed(6));
  assert.strictEqual(cost, expectedDeduct * -1);
  assert.strictEqual(ledgerInserts.length, 1);
  const [ledgerParams] = ledgerInserts;
  assert.strictEqual(ledgerParams[0], 'c1');       // customer_id
  assert.strictEqual(Number(ledgerParams[1]), -cost); // negative amount
  assert.strictEqual(ledgerParams[2], 'ul1');      // usage_log_id link
  assert.match(ledgerParams[3], /streamed/);       // note
});