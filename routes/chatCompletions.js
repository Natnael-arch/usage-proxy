// POST /v1/chat/completions -- authenticates the caller and forwards the
// OpenAI-compatible request to DeepSeek, returning DeepSeek's response as-is.
// Every request (success or failure) produces exactly one usage_logs row.
//
// Streaming requests (body.stream === true) are re-streamed to the caller as
// an SSE passthrough: DeepSeek's chunks are forwarded chunk-by-chunk, and the
// token usage (which only arrives in the final chunk) is extracted afterward
// for metering. A non-2xx upstream response is never streamed -- it is always
// surfaced as a structured JSON error.
const express = require('express');
const { chatCompletions } = require('../services/deepseekClient');
const { calculateCost } = require('../services/costCalculator');
const { logUsage } = require('../services/usageLogger');
const { deductBalance } = require('../services/balanceService');

const router = express.Router();

const PROVIDER = 'deepseek';

function latencyMsSince(startedAt) {
  return Math.round(performance.now() - startedAt);
}

// Parse an SSE document into { model, usage }. DeepSeek streams
// `data: {...}` lines; the final chunk carries usage when
// stream_options.include_usage is set (Hermes sends it). [DONE] ends the doc.
function parseStreamMetadata(sseText) {
  let model = null;
  let usage = null;
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk && typeof chunk === 'object') {
        if (!model && chunk.model) model = chunk.model;
        if (chunk.usage && typeof chunk.usage === 'object') {
          usage = chunk.usage; // DeepSeek includes usage in the final chunk
        }
      }
    } catch {
      // Skip malformed SSE lines; the stream itself was valid upstream data.
    }
  }
  return { model, usage };
}

router.post('/chat/completions', async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object' || !body.model || !Array.isArray(body.messages)) {
    return res.status(400).json({
      error: 'Invalid request body: expected { model: string, messages: [...] }',
    });
  }

  const startedAt = performance.now();
  const isStream = body.stream === true;

  // Logging/deduction failures must never break the response to the caller.
  // safeLog returns the new usage_logs id, or null if the insert failed.
  async function safeLog(entry) {
    try {
      return await logUsage(entry);
    } catch (err) {
      console.error('usage_logs insert failed:', err.message);
      return null;
    }
  }

  // Money tracking is more serious than a logging miss -- log loudly so it is
  // easy to notice and reconcile later, but never block the client response.
  async function safeDeduct(args) {
    try {
      return await deductBalance(args);
    } catch (err) {
      console.error('LEDGER DEDUCTION FAILED -- REQUIRES RECONCILIATION:', err.message);
      return null;
    }
  }

  let upstream;
  try {
    upstream = await chatCompletions(body);
  } catch (err) {
    // Upstream failed (bad key, timeout, 4xx/5xx, network) or returned a
    // non-2xx stream response. Log with the real upstream error message and
    // return a structured error -- never a raw body or crash message.
    const status = err.status && typeof err.status === 'number' ? err.status : 502;
    await safeLog({
      customerId: req.customer_id,
      instanceId: req.instance_id,
      provider: PROVIDER,
      route: body.model,
      inputTokens: null,
      outputTokens: null,
      costCharged: 0,
      latencyMs: latencyMsSince(startedAt),
      status: 'error',
      errorDetail: err.message,
    });
    return res.status(status).json({
      error: { message: err.message, type: 'upstream_error' },
    });
  }

  if (isStream && upstream.streaming) {
    // ---------------------------------------------------------------
    // Streaming passthrough: forward DeepSeek's SSE chunks to the caller
    // as they arrive, while buffering text to extract usage from the
    // final chunk. If the client disconnects mid-stream, we still settle
    // the usage/cost for the tokens DeepSeek actually served.
    // ---------------------------------------------------------------
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const reader = upstream.response.body.getReader();
    const decoder = new TextDecoder();
    let sseText = '';
    let streamBroken = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const str = decoder.decode(value, { stream: true });
        sseText += str;
        res.write(value);
        if (typeof res.flush === 'function') {
          res.flush();
        }
      }
    } catch (err) {
      streamBroken = true;
      console.error('Stream interrupted while forwarding to client:', err.message);
    }

    const { model, usage } = parseStreamMetadata(sseText);
    const route = model || body.model;
    const inputTokens = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : null;
    const outputTokens = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null;

    if (streamBroken) {
      await safeLog({
        customerId: req.customer_id,
        instanceId: req.instance_id,
        provider: PROVIDER,
        route,
        inputTokens,
        outputTokens,
        costCharged: 0,
        latencyMs: latencyMsSince(startedAt),
        status: 'error',
        errorDetail: 'Client disconnected before stream completed',
      });
    } else {
      try {
        const { cost, pricingRateId } = await calculateCost({
          provider: PROVIDER,
          route,
          inputTokens,
          outputTokens,
        });
        const usageLogId = await safeLog({
          customerId: req.customer_id,
          instanceId: req.instance_id,
          provider: PROVIDER,
          route,
          pricingRateId,
          inputTokens,
          outputTokens,
          costCharged: cost,
          latencyMs: latencyMsSince(startedAt),
          status: 'success',
          errorDetail: null,
        });

        if (usageLogId && cost > 0) {
          await safeDeduct({
            customerId: req.customer_id,
            amount: -cost,
            usageLogId,
            note: 'chat_completion usage (streamed)',
          });
        }
      } catch (err) {
        await safeLog({
          customerId: req.customer_id,
          instanceId: req.instance_id,
          provider: PROVIDER,
          route,
          inputTokens,
          outputTokens,
          costCharged: 0,
          latencyMs: latencyMsSince(startedAt),
          status: 'error',
          errorDetail: err.message,
        });
      }
    }

    return res.end();
  }

  // ---------------------------------------------------------------
  // Non-streaming success path.
  // ---------------------------------------------------------------
  const route = upstream.data.model || body.model;
  const inputTokens = upstream.data.usage?.prompt_tokens ?? null;
  const outputTokens = upstream.data.usage?.completion_tokens ?? null;

  try {
    const { cost, pricingRateId } = await calculateCost({
      provider: PROVIDER,
      route,
      inputTokens,
      outputTokens,
    });
    const usageLogId = await safeLog({
      customerId: req.customer_id,
      instanceId: req.instance_id,
      provider: PROVIDER,
      route,
      pricingRateId,
      inputTokens,
      outputTokens,
      costCharged: cost,
      latencyMs: latencyMsSince(startedAt),
      status: 'success',
      errorDetail: null,
    });

    // Post-request settlement: deduct the exact real cost, linked to the
    // usage log row. Skipped entirely on error paths (nothing to charge).
    if (usageLogId && cost > 0) {
      await safeDeduct({
        customerId: req.customer_id,
        amount: -cost,
        usageLogId,
        note: 'chat_completion usage',
      });
    }

    return res.status(200).json(upstream.data);
  } catch (err) {
    // Failed to price the request (e.g. no active pricing rate). Log it
    // distinctly from upstream failures, surface a clear error, don't crash.
    const status = 500;
    await safeLog({
      customerId: req.customer_id,
      instanceId: req.instance_id,
      provider: PROVIDER,
      route,
      inputTokens,
      outputTokens,
      costCharged: 0,
      latencyMs: latencyMsSince(startedAt),
      status: 'error',
      errorDetail: err.message,
    });
    return res.status(status).json({
      error: { message: err.message, type: err.code === 'NO_PRICING_RATE' ? 'missing_pricing_rate' : 'pricing_error' },
    });
  }
});

module.exports = router;