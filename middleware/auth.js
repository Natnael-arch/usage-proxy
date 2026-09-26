// Auth middleware: validates the instance bearer token and authorizes the
// request. On success attaches customer_id and instance_id to req and bumps
// instances.last_seen_at.
//
// Machine-fingerprint binding: when the request carries X-Instance-Fingerprint
// and the instance has a stored fingerprint hash, the two must match or the
// request is refused. Semantic switches:
//   - Header absent            -> warn + allow (older/unbundled clients; never
//                                 a hard failure, per rollout policy).
//   - Stored hash absent       -> warn + allow (token predates binding).
//   - Header present, mismatch -> controlled by FINGERPRINT_ENFORCE:
//       soft (default, rollout): log the mismatch and ALLOW (grace period for
//                                legitimate hardware changes + migration).
//       hard:                    reject with 403 instance_mismatch.
// Only the SHA-256 hash is ever compared; raw hardware id never leaves a host.
const { pool } = require('../db/connection');
const { hashToken } = require('../services/token');

const FINGERPRINT_HEADER = 'x-instance-fingerprint';
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

// Read at request time (not module load) so operators can flip soft -> hard
// without restarting; tests also exercise both modes in one process.
function fingerprintEnforceMode() {
  return (process.env.FINGERPRINT_ENFORCE || 'soft').toLowerCase();
}

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
         i.fingerprint_hash,
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

  // ── Machine-fingerprint check ──────────────────────────────────────────
  const provided = (req.headers[FINGERPRINT_HEADER] || '').trim().toLowerCase();

  if (!provided) {
    console.warn(
      `[FINGERPRINT] instance=${row.instance_id} token=${row.token_id}: authenticated request ` +
      'without X-Instance-Fingerprint (older client or unbundled install); allowing (rollout).'
    );
  } else if (!FINGERPRINT_RE.test(provided)) {
    console.warn(
      `[FINGERPRINT] instance=${row.instance_id} token=${row.token_id}: header present but ` +
      'not a valid SHA-256 hash; ignoring.'
    );
  } else if (!row.fingerprint_hash) {
    console.warn(
      `[FINGERPRINT] instance=${row.instance_id} token=${row.token_id}: fingerprint header sent ` +
      'but no fingerprint bound to this instance (token predates binding); allowing.'
    );
  } else if (provided === row.fingerprint_hash.toLowerCase()) {
    // Match — nothing to do.
  } else {
    // Mismatch. Soft = Machinery: log + allow (grace window). Hard = refuse.
    if (fingerprintEnforceMode() === 'hard') {
      console.warn(
        `[FINGERPRINT] instance=${row.instance_id} token=${row.token_id}: MISMATCH ` +
        `header=${provided.slice(0, 8)}… stored=${row.fingerprint_hash.slice(0, 8)}… ` +
        '— rejecting (FINGERPRINT_ENFORCE=hard).'
      );
      return res.status(403).json({ error: 'instance_mismatch' });
    }
    console.warn(
      `[FINGERPRINT] instance=${row.instance_id} token=${row.token_id}: MISMATCH ` +
      `header=${provided.slice(0, 8)}… stored=${row.fingerprint_hash.slice(0, 8)}… ` +
      '— allowing during soft-enforcement grace window (hard enforcement off).'
    );
  }

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

module.exports = { authenticate, FINGERPRINT_HEADER };
