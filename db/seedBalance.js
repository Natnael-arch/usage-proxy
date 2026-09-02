// Seed/restore a customer's ledger balance (manual/test top-up). Re-runnable:
// skips if a top-up with the same note already exists for the customer, so
// repeated runs don't stack duplicate credits.
//
// Usage:
//   CUSTOMER_ID=<uuid> npm run seed:balance          # top up a specific customer
//   npm run seed:balance                             # defaults to newest customer
//   SEED_BALANCE=10.00 SEED_BALANCE_NOTE="aug topup" npm run seed:balance
require('dotenv').config();
const { pool } = require('./connection');
const { topUp, getBalance } = require('../services/balanceService');

async function seedBalance() {
  let customerId = process.env.CUSTOMER_ID;

  if (!customerId) {
    const { rows } = await pool.query(
      'SELECT id FROM customers ORDER BY created_at DESC LIMIT 1'
    );
    if (rows.length === 0) throw new Error('No customers exist to top up');
    customerId = rows[0].id;
    console.log(`CUSTOMER_ID not set; using newest customer ${customerId}`);
  }

  const amount = Number(process.env.SEED_BALANCE ?? 5.0);
  const note = process.env.SEED_BALANCE_NOTE || 'initial test balance';

  const existing = await pool.query(
    `SELECT id, amount FROM ledger_entries
     WHERE customer_id = $1 AND entry_type = 'topup' AND note = $2`,
    [customerId, note]
  );

  if (existing.rows.length > 0) {
    const e = existing.rows[0];
    console.log('Top-up with this note already exists (skipping insert):');
    console.log(`  ledger_entry_id ${e.id}`);
    console.log(`  amount          ${e.amount}`);
  } else {
    const id = await topUp({ customerId, amount, note });
    console.log('Inserted top-up:');
    console.log(`  ledger_entry_id ${id}`);
    console.log(`  customer_id     ${customerId}`);
    console.log(`  amount          ${amount}`);
    console.log(`  note            ${note}`);
  }

  console.log(`  balance now     ${await getBalance(customerId)}`);
}

seedBalance()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seed balance failed:', err.message);
    process.exit(1);
  });