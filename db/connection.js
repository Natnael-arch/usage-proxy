// Database connection pool. Reads connection params from the environment
// (DATABASE_URL, or postgresql.conf-style fallbacks).
const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;
console.log(`Connecting to database: ${connectionString ? connectionString.replace(/:[^:@/]+@/, ':***@') : '(none)'}`);

const pool = new Pool({
  connectionString,
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  query_timeout: 15000,
});

module.exports = { pool };
