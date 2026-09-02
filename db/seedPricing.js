// Seed pricing rate for DeepSeek chat completions. Re-runnable: if an active
// rate (effective_to IS NULL) already exists for the same provider/route, it
// is left untouched rather than duplicated.
//
// Rates are DeepSeek's official OFF-PEAK list prices for deepseek-v4-flash,
// per https://api-docs.deepseek.com/quick_start/pricing (verified 2026-09-01):
//   input  $0.22 / 1M tokens  -> 0.000220 / 1k
//   output $0.66 / 1M tokens  -> 0.000660 / 1k
// Peak hours (Mon-Fri 01:00-04:00 & 06:00-10:00 UTC) are double these rates;
// we price at the standard off-peak rate. Change easy here or via edit later.
//
// Addis AI translate route uses the Addis-Aleph-1 model token rates, per
// https://addisassistant.com/pricing (verified 2026-09-01):
//   input  $0.0019 / 1k tokens
//   output $0.0051 / 1k tokens
// Translation is included in the model's token pricing (no separate endpoint).
require('dotenv').config();
const { pool } = require('./connection');

const RATES = [
  {
    provider: 'deepseek',
    model_or_route: 'deepseek-v4-flash',
    input_cost_per_1k: 0.000220, // $0.22 / 1M tokens
    output_cost_per_1k: 0.000660, // $0.66 / 1M tokens
    your_margin_pct: 0, // pilot/demo phase — revisit before real customer billing
  },
  {
    provider: 'addisai',
    model_or_route: 'translate',
    input_cost_per_1k: 0.001900, // $0.0019 / 1k tokens
    output_cost_per_1k: 0.005100, // $0.0051 / 1k tokens
    your_margin_pct: 0, // pilot/demo phase — revisit before real customer billing
  },
];

async function seedPricing() {
  for (const { provider, model_or_route, input_cost_per_1k, output_cost_per_1k, your_margin_pct } of RATES) {
    const existing = await pool.query(
      `SELECT id, provider, model_or_route, input_cost_per_1k,
              output_cost_per_1k, your_margin_pct, effective_from
       FROM pricing_rates
       WHERE provider = $1 AND model_or_route = $2 AND effective_to IS NULL`,
      [provider, model_or_route]
    );

    if (existing.rows.length > 0) {
      const r = existing.rows[0];
      console.log('Active pricing rate already exists (skipping insert):');
      console.log(`  id              ${r.id}`);
      console.log(`  provider/route  ${r.provider} / ${r.model_or_route}`);
      console.log(`  input/1k        ${r.input_cost_per_1k}`);
      console.log(`  output/1k       ${r.output_cost_per_1k}`);
      console.log(`  margin          ${r.your_margin_pct}%`);
      console.log(`  effective_from  ${r.effective_from}`);
      continue;
    }

    const res = await pool.query(
      `INSERT INTO pricing_rates
         (provider, model_or_route, input_cost_per_1k, output_cost_per_1k,
          your_margin_pct, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, $5, now(), NULL)
       RETURNING id, provider, model_or_route, input_cost_per_1k,
                 output_cost_per_1k, your_margin_pct`,
      [provider, model_or_route, input_cost_per_1k, output_cost_per_1k, your_margin_pct]
    );

    console.log('Inserted pricing rate:');
    console.log(res.rows[0]);
  }
}

seedPricing()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seed pricing failed:', err.message);
    process.exit(1);
  });