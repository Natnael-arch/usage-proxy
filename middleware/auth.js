// Auth middleware: validates the instance bearer token and authorizes the
// request. On success attaches customer_id and instance_id to req and bumps
// instances.last_seen_at.
const { pool } = require('../db/connection');
const { hashToken } = require('../services/token');

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const tokenHash = hashToken(token);

  let row;
  try {
    const result = await pool.query(
      `SELECT
         t.id              AS token_id,
         t.token_hash,
         t.expires_at,
         t.revoked_at,
         t.revoked_reason,
         i.id              AS instance_id,
         i.status          AS instance_status,
         i.customer_id,
         c.status          AS customer_status
       FROM auth_tokens t
       JOIN instances i  ON i.id = t.instance_id
       JOIN customers c  ON c.id = i.customer_id
       WHERE t.token_hash = $1`,
      [tokenHash]
    );
    row = result.rows[0];
  } catch (err) {
    console.error('Auth lookup failed:', err.message);
    return res.status(500).json({ error: 'Internal error during authentication' });
  }

  if (!row) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (row.revoked_at) {
    return res.status(401).json({ error: 'Token has been revoked' });
  }

  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    return res.status(401).json({ error: 'Token has expired' });
  }

  if (row.instance_status !== 'active') {
    return res.status(403).json({ error: 'Instance is not active' });
  }

  if (row.customer_status !== 'active') {
    return res.status(403).json({ error: 'Customer account is not active' });
  }

  req.customer_id = row.customer_id;
  req.instance_id = row.instance_id;

  try {
    await pool.query(
      'UPDATE instances SET last_seen_at = now() WHERE id = $1',
      [row.instance_id]
    );
  } catch (err) {
    // Non-fatal: last_seen tracking should not block the request.
    console.error('Failed to update last_seen_at:', err.message);
  }

  return next();
}

module.exports = { authenticate };
