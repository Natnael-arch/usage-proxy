// Seed pricing rate for DeepSeek chat completions. Re-runnable: if an active
// rate (effective_to IS NULL) already exists for the same provider/route, it
// is updated to the seeded values if they differ, otherwise left untouched
// (never duplicated).
//
// Rates are DeepSeek's official off-peak, cache-miss baseline list prices for
// deepseek-flash, per https://api-docs.deepseek.com/quick_start/pricing
// (verified 2026-09-10, model renamed to deepseek-flash; legacy
// deepseek-v4-flash still routes to the same model):
//   input  $0.15 / 1M tokens  -> 0.000150 / 1k
//   output $0.60 / 1M tokens  -> 0.000600 / 1k
// Caveat: DeepSeek's real pricing varies by cache-hit vs. cache-miss input and
// by peak vs. off-peak time-of-day (Mon-Fri 01:00-04:00 & 06:00-10:00 UTC are
// ~2x). We seed a single flat off-peak/cache-miss rate; see
// docs/known-issues.md for the flattening limitation.
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
    model_or_route: 'deepseek-flash',
    input_cost_per_1k: 0.000150, // $0.15 / 1M tokens (off-peak, cache-miss)
    output_cost_per_1k: 0.000600, // $0.60 / 1M tokens (off-peak)
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
      const needsUpdate =
        Number(r.input_cost_per_1k) !== input_cost_per_1k ||
        Number(r.output_cost_per_1k) !== output_cost_per_1k ||
        Number(r.your_margin_pct) !== your_margin_pct;

      if (needsUpdate) {
        const res = await pool.query(
          `UPDATE pricing_rates
           SET input_cost_per_1k = $3, output_cost_per_1k = $4, your_margin_pct = $5
           WHERE id = $1
           RETURNING id, provider, model_or_route, input_cost_per_1k,
                     output_cost_per_1k, your_margin_pct`,
          [r.id, input_cost_per_1k, output_cost_per_1k, your_margin_pct]
        );
        console.log('Updated pricing rate:');
        console.log(res.rows[0]);
        continue;
      }

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