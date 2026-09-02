// Database connection pool. Reads connection params from the environment
// (DATABASE_URL, or postgresql.conf-style fallbacks).
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

module.exports = { pool };
