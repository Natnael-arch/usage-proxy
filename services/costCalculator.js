// Cost calculator: looks up the active pricing rate for a provider/route and
// computes the all-in cost (upstream cost + our margin per 1k tokens).
const { pool } = require('../db/connection');

async function calculateCost({ provider, route, inputTokens, outputTokens }) {
  const input = Number.isFinite(inputTokens) ? inputTokens : 0;
  const output = Number.isFinite(outputTokens) ? outputTokens : 0;

  const { rows } = await pool.query(
    `SELECT id, input_cost_per_1k, output_cost_per_1k, your_margin_pct
     FROM pricing_rates
     WHERE provider = $1
       AND model_or_route = $2
       AND effective_to IS NULL
     ORDER BY effective_from DESC
     LIMIT 1`,
    [provider, route]
  );

  if (rows.length === 0) {
    const err = new Error(
      `No active pricing rate for ${provider} / ${route}`
    );
    err.code = 'NO_PRICING_RATE';
    throw err;
  }

  const rate = rows[0];
  const marginPct = Number(rate.your_margin_pct);
  const base =
    (input / 1000) * Number(rate.input_cost_per_1k) +
    (output / 1000) * Number(rate.output_cost_per_1k);
  // Column precision is NUMERIC(10,6); round to 6 dp so stored cost
  // exactly matches what we report.
  const cost = Number((base * (1 + marginPct / 100)).toFixed(6));

  return { cost, pricingRateId: rate.id };
}

module.exports = { calculateCost };