// Token utilities.
// generateToken() produces a random, high-entropy bearer token (32+ bytes).
// hashToken() returns its SHA-256 hex digest, which is the only form stored
// in the database. The plaintext token must never be stored or logged.
const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

module.exports = { generateToken, hashToken };
