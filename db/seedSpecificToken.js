// Helper script to seed a specific Bearer token into PostgreSQL
require('dotenv').config();
const { pool } = require('./connection');
const { hashToken } = require('../services/token');
const { topUp } = require('../services/balanceService');

async function seedSpecificToken(targetToken) {
  if (!targetToken) {
    console.error('Usage: node db/seedSpecificToken.js <token>');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get or create customer
    let customerRes = await client.query(`SELECT id FROM customers WHERE name = 'Default Customer'`);
    let customerId;
    if (customerRes.rows.length === 0) {
      const newCust = await client.query(
        `INSERT INTO customers (name, contact_email, status, notes)
         VALUES ('Default Customer', 'admin@example.com', 'active', 'Seeded customer')
         RETURNING id`
      );
      customerId = newCust.rows[0].id;
      await topUp({ customerId, amount: 100.0, note: 'Initial test balance' }, client);
    } else {
      customerId = customerRes.rows[0].id;
    }

    // Get or create instance
    let instanceRes = await client.query(`SELECT id FROM instances WHERE customer_id = $1`, [customerId]);
    let instanceId;
    if (instanceRes.rows.length === 0) {
      const newInst = await client.query(
        `INSERT INTO instances (customer_id, label, status) VALUES ($1, 'Default Instance', 'active') RETURNING id`,
        [customerId]
      );
      instanceId = newInst.rows[0].id;
    } else {
      instanceId = instanceRes.rows[0].id;
    }

    const tokenHash = hashToken(targetToken);
    await client.query(
      `INSERT INTO auth_tokens (instance_id, token_hash)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [instanceId, tokenHash]
    );

    await client.query('COMMIT');
    console.log(`✅ Token successfully registered in database!`);
    console.log(`  Customer ID: ${customerId}`);
    console.log(`  Instance ID: ${instanceId}`);
    console.log(`  Token Hash:  ${tokenHash}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to seed token:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

const tokenToSeed = process.argv[2] || process.env.PROXY_TOKEN || process.env.INITIAL_AUTH_TOKEN;
seedSpecificToken(tokenToSeed);
