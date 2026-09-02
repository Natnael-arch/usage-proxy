// POST /v1/translate -- authenticates the caller and forwards a translation
// request to Addis AI, returning the result. Every request (success or
// failure) produces exactly one usage_logs row.
const express = require('express');
const { translate } = require('../services/addisaiClient');
const { calculateCost } = require('../services/costCalculator');
const { logUsage } = require('../services/usageLogger');
const { deductBalance } = require('../services/balanceService');

const router = express.Router();

const PROVIDER = 'addisai';
const ROUTE = 'translate';

// Supported languages per Addis AI docs: am (Amharic), om (Afaan Oromo), en.
const SUPPORTED_LANGUAGES = new Set(['am', 'om', 'en']);

function latencyMsSince(startedAt) {
  return Math.round(performance.now() - startedAt);
}

router.post('/translate', async (req, res) => {
  const { text, source_language, target_language } = req.body || {};

  // Validate before hitting Addis AI -- don't send garbage upstream.
  if (typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text must be a non-empty string' });
  }
  if (!SUPPORTED_LANGUAGES.has(source_language)) {
    return res.status(400).json({
      error: 'source_language must be one of: am, om, en',
    });
  }
  if (!SUPPORTED_LANGUAGES.has(target_language)) {
    return res.status(400).json({
      error: 'target_language must be one of: am, om, en',
    });
  }
  if (source_language === target_language) {
    return res.status(400).json({
      error: 'source_language and target_language must be different',
    });
  }

  const startedAt = performance.now();

  // Logging/deduction failures must never break the response to the caller.
  async function safeLog(entry) {
    try {
      return await logUsage(entry);
    } catch (err) {
      console.error('usage_logs insert failed:', err.message);
      return null;
    }
  }

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
    upstream = await translate({ text, source_language, target_language });
  } catch (err) {
    const status = err.status && typeof err.status === 'number' ? err.status : 502;
    await safeLog({
      customerId: req.customer_id,
      instanceId: req.instance_id,
      provider: PROVIDER,
      route: ROUTE,
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

  // Extract token counts from usage_metadata.
  const usage = upstream?.data?.usage_metadata || {};
  const inputTokens = usage.prompt_token_count ?? null;
  const outputTokens = usage.candidates_token_count ?? null;

  try {
    const { cost, pricingRateId } = await calculateCost({
      provider: PROVIDER,
      route: ROUTE,
      inputTokens,
      outputTokens,
    });
    const usageLogId = await safeLog({
      customerId: req.customer_id,
      instanceId: req.instance_id,
      provider: PROVIDER,
      route: ROUTE,
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
        note: 'translation usage',
      });
    }

    // Return the translation result; pass through quality too if present.
    return res.status(200).json(upstream.data);
  } catch (err) {
    // Failed to price the request (e.g. no active pricing rate).
    const status = 500;
    await safeLog({
      customerId: req.customer_id,
      instanceId: req.instance_id,
      provider: PROVIDER,
      route: ROUTE,
      inputTokens,
      outputTokens,
      costCharged: 0,
      latencyMs: latencyMsSince(startedAt),
      status: 'error',
      errorDetail: err.message,
    });
    return res.status(status).json({
      error: {
        message: err.message,
        type: err.code === 'NO_PRICING_RATE' ? 'missing_pricing_rate' : 'pricing_error',
      },
    });
  }
});

module.exports = router;