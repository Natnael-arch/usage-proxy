// Seed script: creates one test customer, one instance, and one auth token.
// Prints the plaintext token once to the console -- it can only be verified
// later, never retrieved, so write it down now.
require('dotenv').config();
const { pool } = require('./connection');
const { generateToken, hashToken } = require('../services/token');
const { topUp } = require('../services/balanceService');

async function seed() {
  const customerName = process.env.SEED_CUSTOMER_NAME || 'Test Customer';
  const customerEmail = process.env.SEED_CUSTOMER_EMAIL || 'test@example.com';
  const instanceLabel = process.env.SEED_INSTANCE_LABEL || 'Test Instance';
  const seedBalance = Number(process.env.SEED_BALANCE ?? 5.0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerRes = await client.query(
      `INSERT INTO customers (name, contact_email, status, notes)
       VALUES ($1, $2, 'active', 'Seeded test customer')
       RETURNING id`,
      [customerName, customerEmail]
    );
    const customerId = customerRes.rows[0].id;

    const instanceRes = await client.query(
      `INSERT INTO instances (customer_id, label, status)
       VALUES ($1, $2, 'active')
       RETURNING id`,
      [customerId, instanceLabel]
    );
    const instanceId = instanceRes.rows[0].id;

    const token = generateToken();
    await client.query(
      `INSERT INTO auth_tokens (instance_id, token_hash)
       VALUES ($1, $2)`,
      [instanceId, hashToken(token)]
    );

    // Initial test balance -- a fresh customer gets a fresh top-up, so this
    // never stacks duplicates with previous seed runs.
    await topUp({ customerId, amount: seedBalance, note: 'initial test balance' }, client);

    await client.query('COMMIT');

    console.log('Seeded test records:');
    console.log(`  customer_id  ${customerId}`);
    console.log(`  instance_id  ${instanceId}`);
    console.log(`  balance      $${seedBalance.toFixed(2)}`);
    console.log('');
    console.log('AUTH TOKEN (store securely; cannot be retrieved later):');
    console.log(token);
    console.log('');
    console.log('Example request:');
    console.log(
      `  curl -s http://localhost:${process.env.PORT || 8787}/v1/chat/completions \\\n` +
        `    -H "Authorization: Bearer ${token}" \\\n` +
        `    -H "Content-Type: application/json" \\\n` +
        `    -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'`
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  });
