// Onboarding script: create a B2B customer, one instance, and a one-time
// activation code the agent-gateway will exchange for a real auth token at
// POST /v1/activate. Prints ONLY the plaintext activation code to the console
// -- it is stored hashed, so write it down now and hand it to the customer.
require('dotenv').config();
const { pool } = require('../db/connection');
const { generateToken, hashToken } = require('../services/token');

// Expiry: first CLI arg (dd), else ACTIVATION_DAYS env, else 7 days.
const days = (() => {
  const raw = process.argv[2];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    console.error('First arg must be a positive number of days.');
    process.exit(1);
  }
  const env = Number(process.env.ACTIVATION_DAYS ?? 7);
  return Number.isFinite(env) && env > 0 ? env : 7;
})();

async function createCustomer() {
  const name = process.argv[3] || process.env.CUSTOMER_NAME || 'New Customer';
  const email = process.argv[4] || process.env.CUSTOMER_EMAIL || `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`;
  const instanceLabel = process.argv[5] || process.env.INSTANCE_LABEL || 'Default Instance';

  const code = generateToken();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerRes = await client.query(
      `INSERT INTO customers (name, contact_email, status, notes)
       VALUES ($1, $2, 'active', 'Created via createCustomer script, waiting for activation')
       RETURNING id`,
      [name, email]
    );
    const customerId = customerRes.rows[0].id;

    const instanceRes = await client.query(
      `INSERT INTO instances (customer_id, label, status)
       VALUES ($1, $2, 'active')
       RETURNING id`,
      [customerId, instanceLabel]
    );
    const instanceId = instanceRes.rows[0].id;

    await client.query(
      `INSERT INTO activation_codes (customer_id, instance_id, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
      [customerId, instanceId, hashToken(code), days]
    );

    await client.query('COMMIT');

    console.log('Created customer + instance + activation code:');
    console.log(`  customer_id  ${customerId}`);
    console.log(`  instance_id  ${instanceId}`);
    console.log(`  code expiry  ${days} day(s) from now`);
    console.log('');
    console.log('ACTIVATION CODE (store securely; cannot be retrieved later):');
    console.log(code);
    console.log('');
    console.log('Hand this code to the customer. They run it against the proxy:');
    console.log(`  curl -s ${process.env.PROXY_BASE_URL || 'http://localhost:8787'}/v1/activate \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"activation_code":"${code}"}'`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

createCustomer()
  .then(() => pool.end())
  .catch((err) => {
    console.error('createCustomer failed:', err.message);
    process.exit(1);
  });
