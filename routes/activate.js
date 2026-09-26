// Public onboarding endpoint: exchange a one-time activation code for a real
// instance auth token. This route is intentionally NOT behind the
// authenticate middleware -- the whole point is that the caller has no token
// yet. The plaintext token is returned exactly once and never stored.
const express = require('express');
const { pool } = require('../db/connection');
const { generateToken, hashToken } = require('../services/token');

const router = express.Router();

function error(res, status, code) {
  return res.status(status).json({ error: code });
}

// A valid machine fingerprint is a SHA-256 hex digest (64 lowercase hex).
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

router.post('/activate', async (req, res) => {
  const code = typeof req.body?.activation_code === 'string'
    ? req.body.activation_code.trim()
    : '';

  if (!code) {
    return error(res, 400, 'missing_activation_code');
  }

  const fingerprint = typeof req.body?.fingerprint === 'string'
    ? req.body.fingerprint.trim().toLowerCase()
    : '';

  if (fingerprint && !FINGERPRINT_RE.test(fingerprint)) {
    return error(res, 400, 'invalid_fingerprint');
  }

  const codeHash = hashToken(code);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const codeRes = await client.query(
      `SELECT id, customer_id, instance_id, expires_at, used_at
       FROM activation_codes
       WHERE code_hash = $1
       FOR UPDATE`,
      [codeHash]
    );

    const row = codeRes.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return error(res, 404, 'invalid_code');
    }

    if (row.used_at) {
      await client.query('ROLLBACK');
      return error(res, 409, 'code_already_used');
    }

    if (new Date(row.expires_at) <= new Date()) {
      await client.query('ROLLBACK');
      return error(res, 410, 'code_expired');
    }

    const token = generateToken();

    const tokenRes = await client.query(
      `INSERT INTO auth_tokens (instance_id, token_hash)
       VALUES ($1, $2)
       RETURNING id`,
      [row.instance_id, hashToken(token)]
    );
    const tokenId = tokenRes.rows[0].id;

    await client.query(
      `UPDATE activation_codes
       SET used_at = now(), used_token_id = $1
       WHERE id = $2`,
      [tokenId, row.id]
    );

    // Bind the machine fingerprint to the per-install instance row. The code
    // determines which instance is being activated; redeeming a new code for
    // the SAME instance re-binds the fingerprint (operator rebind path).
    if (fingerprint) {
      await client.query(
        `UPDATE instances
         SET fingerprint_hash = $1, fingerprint_bound_at = now()
         WHERE id = $2`,
        [fingerprint, row.instance_id]
      );
    }

    await client.query('COMMIT');

    return res.status(200).json({ token, fingerprint_bound: !!fingerprint });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Activation failed:', err.message);
    return error(res, 500, 'internal_error');
  } finally {
    client.release();
  }
});

module.exports = router;
