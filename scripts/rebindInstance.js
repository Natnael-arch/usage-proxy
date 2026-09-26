// Operator script (requirement 5b: legitimate hardware-change rebind).
//
// When a customer gets a new machine, the stored instance fingerprint no
// longer matches and (once hard enforcement is on) their old token is refused.
// The FIX is always operator-initiated — never self-service from the token:
//
//   1. Ask the customer (or their installer) to print their fingerprint:
//        node services/fingerprint.js        # -> <sha256>
//   2. Run this script to overwrite the stored hash for that instance:
//        node scripts/rebindInstance.js <instanceId> <fingerprintHash>
//
// This is the quick rebind path; a fresh activation code for the same instance
// (see createCustomer.js --rebind=<id>) is the supervised alternative. Both
// overwrite instances.fingerprint_hash. Only SHA-256 hashes are stored.
//
// Safeguards:
//   - Refuses to run unless the fingerprint is a valid 64-hex SHA-256 hash.
//   - Requires an explicit --confirm flag (no accidental rebinds).
//   - Prints the BEFORE hash up to the first 8 chars so support can verify
//     the change is intentional before it is applied.
require('dotenv').config();
const { pool } = require('../db/connection');

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

const instanceId = process.argv[2];
const fingerprint = (process.argv[3] || '').toLowerCase();
const confirmed = process.argv.includes('--confirm');

if (!instanceId || !fingerprint) {
  console.error('Usage: node scripts/rebindInstance.js <instanceId> <fingerprintHash> [--confirm]');
  console.error('');
  console.error('Get the NEW fingerprint from the customer/host:');
  console.error('  node services/fingerprint.js');
  console.error('');
  console.error('Current stored hash (partial) is shown; add --confirm to write.');
  process.exit(1);
}

if (!FINGERPRINT_RE.test(fingerprint)) {
  console.error('ERROR: fingerprint must be a 64-char lowercase SHA-256 hex hash.');
  console.error('Re-run `node services/fingerprint.js` on the customer machine.');
  process.exit(1);
}

async function rebind() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const instRes = await client.query(
      `SELECT id, customer_id, label, fingerprint_hash FROM instances WHERE id = $1`,
      [instanceId]
    );
    const inst = instRes.rows[0];
    if (!inst) {
      await client.query('ROLLBACK');
      console.error(`No instance found with id ${instanceId}`);
      process.exit(1);
    }

    const oldHash = inst.fingerprint_hash || null;
    const oldPreview = oldHash ? oldHash.slice(0, 8) : '(none)';
    const newPreview = fingerprint.slice(0, 8);

    console.log(`Instance            ${inst.id}`);
    console.log(`Label               ${inst.label}`);
    console.log(`Customer            ${inst.customer_id}`);
    console.log(`Fingerprint now     ${oldPreview}…`);
    console.log(`Fingerprint new     ${newPreview}…`);

    if (!confirmed) {
      console.log('');
      console.log('This is a supervised rebind. Add --confirm to apply.');
      try {
        await client.query('ROLLBACK');
      } finally {
        pool.end();
      }
      process.exit(0);
    }

    if (oldHash === fingerprint) {
      console.log('');
      console.log('New fingerprint equals the stored hash — nothing to change.');
      await client.query('ROLLBACK');
      pool.end();
      return;
    }

    await client.query(
      `UPDATE instances
       SET fingerprint_hash = $1, fingerprint_bound_at = now()
       WHERE id = $2`,
      [fingerprint, instanceId]
    );
    await client.query('COMMIT');

    console.log('');
    console.log(`Rebound instance ${instanceId}: ${oldPreview}… -> ${newPreview}…`);
    console.log('The token now authenticates from the new machine. No new code');
    console.log('was needed because hard enforcement is superseded by this rebind.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('rebindInstance failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    pool.end();
  }
}

rebind().catch((err) => {
  console.error(err.message);
  process.exit(1);
});