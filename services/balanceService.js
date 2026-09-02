// Balance service: reads and mutates a customer's ledger balance.
// Balance = SUM(amount) over ledger_entries. Positive entries are top-ups,
// negative entries are usage deductions.
const { pool } = require('../db/connection');

// db is overridable (e.g. a transaction client) via the optional db field.
async function getBalance(customerId, db = pool) {
  const { rows } = await db.query(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_entries WHERE customer_id = $1',
    [customerId]
  );
  return Number(rows[0].balance);
}

// Deduct a usage cost from the customer's ledger. amount must be negative.
async function deductBalance({ customerId, amount, usageLogId, note }, db = pool) {
  if (amount >= 0) {
    throw new Error('deductBalance expects a negative amount');
  }
  const res = await db.query(
    `INSERT INTO ledger_entries
       (customer_id, amount, entry_type, related_usage_log_id, note)
     VALUES ($1, $2, 'usage_deduction', $3, $4)
     RETURNING id`,
    [customerId, amount, usageLogId, note]
  );
  return res.rows[0].id;
}

// Top up a customer's balance. amount must be positive. Not wired to any
// payment route yet -- for seeding test balances and manual top-ups.
async function topUp({ customerId, amount, note }, db = pool) {
  if (amount <= 0) {
    throw new Error('topUp expects a positive amount');
  }
  const res = await db.query(
    `INSERT INTO ledger_entries
       (customer_id, amount, entry_type, note)
     VALUES ($1, $2, 'topup', $3)
     RETURNING id`,
    [customerId, amount, note]
  );
  return res.rows[0].id;
}

module.exports = { getBalance, deductBalance, topUp };