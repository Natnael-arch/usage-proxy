// Usage logger: writes exactly one usage_logs row per request. Never used to
// block requests -- failures to log are reported to the console instead.
const { pool } = require('../db/connection');

async function logUsage({
  customerId,
  instanceId,
  provider,
  route,
  pricingRateId = null,
  inputTokens = null,
  outputTokens = null,
  costCharged = 0,
  latencyMs,
  status,
  errorDetail = null,
}) {
  const result = await pool.query(
    `INSERT INTO usage_logs
       (customer_id, instance_id, provider, route, pricing_rate_id,
        input_tokens, output_tokens, cost_charged, latency_ms, status,
        error_detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      customerId,
      instanceId,
      provider,
      route,
      pricingRateId,
      inputTokens,
      outputTokens,
      costCharged,
      latencyMs,
      status,
      errorDetail,
    ]
  );
  return result.rows[0].id;
}

module.exports = { logUsage };