// Operator script: check a customer's balance and recent ledger history.
//
// Usage:
//   node scripts/checkBalance.js <customerId>
//
// Example:
//   node scripts/checkBalance.js 35e08c4c-2194-44d3-8b4e-9530ad37877e

require('dotenv').config();
const { pool } = require('../db/connection');
const { getBalance } = require('../services/balanceService');

const customerId = process.argv[2];

if (!customerId || customerId.startsWith('--')) {
  console.error('Usage: node scripts/checkBalance.js <customerId>');
  console.error('');
  console.error('Example:');
  console.error('  node scripts/checkBalance.js 35e08c4c-2194-44d3-8b4e-9530ad37877e');
  process.exit(1);
}

async function run() {
  const custRes = await pool.query(
    'SELECT id, name, contact_email, status FROM customers WHERE id = $1',
    [customerId]
  );
  const customer = custRes.rows[0];

  if (!customer) {
    console.error(`ERROR: No customer found with id "${customerId}"`);
    process.exit(1);
  }

  const currentBalance = await getBalance(customer.id);

  const ledgerRes = await pool.query(
    `SELECT created_at, amount, entry_type, note
     FROM ledger_entries
     WHERE customer_id = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [customer.id]
  );

  console.log('========================================');
  console.log('  CUSTOMER BALANCE & HISTORY');
  console.log('========================================');
  console.log(`  Customer ID:     ${customer.id}`);
  console.log(`  Customer Name:   ${customer.name}`);
  console.log(`  Contact Email:   ${customer.contact_email}`);
  console.log(`  Customer Status: ${customer.status}`);
  console.log(`  Current Balance: $${currentBalance.toFixed(2)}`);
  console.log('========================================');
  console.log('  RECENT LEDGER ENTRIES (Last 5):');
  console.log('========================================');

  if (ledgerRes.rows.length === 0) {
    console.log('  No ledger entries found.');
  } else {
    ledgerRes.rows.forEach((entry, idx) => {
      const amt = Number(entry.amount);
      const formattedAmount = amt >= 0 ? `+$${amt.toFixed(2)}` : `-$${Math.abs(amt).toFixed(2)}`;
      const dateStr = new Date(entry.created_at).toISOString();
      console.log(`  ${idx + 1}. [${dateStr}] ${formattedAmount} (${entry.entry_type})`);
      if (entry.note) {
        console.log(`     Note: ${entry.note}`);
      }
    });
  }
  console.log('========================================');
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error('checkBalance failed:', err.message);
    pool.end();
    process.exit(1);
  });
