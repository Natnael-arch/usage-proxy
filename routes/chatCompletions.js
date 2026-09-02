// POST /v1/chat/completions -- authenticates the caller and forwards the
// OpenAI-compatible request to DeepSeek, returning DeepSeek's response as-is.
// Every request (success or failure) produces exactly one usage_logs row.
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

router.post('/chat/completions', async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object' || !body.model || !Array.isArray(body.messages)) {
    return res.status(400).json({
      error: 'Invalid request body: expected { model: string, messages: [...] }',
    });
  }

  const startedAt = performance.now();

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
    // Upstream failed (bad key, timeout, 4xx/5xx, network). Log with the real
    // upstream error message so a timeout looks different from other failures.
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

  // Upstream succeeded. Resolve the actual billed model (DeepSeek may rewrite
  // aliases like deepseek-chat to deepseek-v4-flash) and extract token counts.
  const route = upstream.model || body.model;
  const inputTokens = upstream.usage?.prompt_tokens ?? null;
  const outputTokens = upstream.usage?.completion_tokens ?? null;

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

    return res.status(200).json(upstream);
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