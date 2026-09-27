// Operator script: top up a customer's ledger balance.
//
// Usage:
//   node scripts/topUpBalance.js <customerId> <amount> [note] [--confirm]
//
// Examples:
//   Preview top-up (dry run):
//     node scripts/topUpBalance.js 35e08c4c-2194-44d3-8b4e-9530ad37877e 50.00 "Initial credit"
//
//   Apply top-up to production database:
//     node scripts/topUpBalance.js 35e08c4c-2194-44d3-8b4e-9530ad37877e 50.00 "Initial credit" --confirm

require('dotenv').config();
const { pool } = require('../db/connection');
const { getBalance, topUp } = require('../services/balanceService');

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm');
const positionals = args.filter((a) => !a.startsWith('--'));

const customerId = positionals[0];
const amountRaw = positionals[1];
const note = positionals.slice(2).join(' ') || 'Manual operator top-up';

if (!customerId || amountRaw === undefined) {
  console.error('Usage: node scripts/topUpBalance.js <customerId> <amount> [note] [--confirm]');
  console.error('');
  console.error('Example:');
  console.error('  node scripts/topUpBalance.js <customerId> 50.00 "Initial credit"');
  console.error('  node scripts/topUpBalance.js <customerId> 50.00 "Initial credit" --confirm');
  process.exit(1);
}

const amount = Number(amountRaw);
if (!Number.isFinite(amount) || amount <= 0) {
  console.error(`ERROR: Amount must be a positive number of dollars (e.g. 50.00). Received: "${amountRaw}"`);
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

  if (!confirmed) {
    console.log('========================================');
    console.log('  TOP-UP PREVIEW (DRY RUN)');
    console.log('========================================');
    console.log(`  Customer ID:     ${customer.id}`);
    console.log(`  Customer Name:   ${customer.name}`);
    console.log(`  Contact Email:   ${customer.contact_email}`);
    console.log(`  Customer Status: ${customer.status}`);
    console.log(`  Current Balance: $${currentBalance.toFixed(2)}`);
    console.log(`  Top-Up Amount:   +$${amount.toFixed(2)}`);
    console.log(`  Result Balance:  $${(currentBalance + amount).toFixed(2)}`);
    console.log(`  Note:            ${note}`);
    console.log('========================================');
    console.log('  DRY RUN ONLY — No database changes were made.');
    console.log('  Re-run with --confirm to apply this top-up:');
    console.log(`    node scripts/topUpBalance.js ${customer.id} ${amount.toFixed(2)} "${note}" --confirm`);
    return;
  }

  const entryId = await topUp({ customerId: customer.id, amount, note });
  const newBalance = await getBalance(customer.id);

  console.log('========================================');
  console.log('  TOP-UP SUCCESSFUL');
  console.log('========================================');
  console.log(`  Customer ID:      ${customer.id}`);
  console.log(`  Customer Name:    ${customer.name}`);
  console.log(`  Contact Email:    ${customer.contact_email}`);
  console.log(`  Previous Balance: $${currentBalance.toFixed(2)}`);
  console.log(`  Added Amount:     +$${amount.toFixed(2)}`);
  console.log(`  New Balance:      $${newBalance.toFixed(2)}`);
  console.log(`  Note:             ${note}`);
  console.log(`  Ledger Entry ID:  ${entryId}`);
  console.log('========================================');
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Top-up failed:', err.message);
    pool.end();
    process.exit(1);
  });
