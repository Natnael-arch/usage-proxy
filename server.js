// Usage proxy -- phases 1-4: auth, DeepSeek pass-through, metering, and
// balance enforcement. No Addis AI (phase 5) or rate limiting (phase 6) yet.
require('dotenv').config();
const express = require('express');
const { authenticate } = require('./middleware/auth');
const { checkBalance } = require('./middleware/balanceCheck');
const chatCompletionsRouter = require('./routes/chatCompletions');
const translateRouter = require('./routes/translate');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Authenticated routes: auth first, then a pre-flight balance check.
app.use('/v1', authenticate, checkBalance, chatCompletionsRouter);
app.use('/v1', authenticate, checkBalance, translateRouter);

// Fallback for unknown routes
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const { migrate } = require('./db/migrate');

const PORT = process.env.PORT || 8787;

async function startServer() {
  try {
    console.log('[DB] Running database migrations...');
    await migrate();
  } catch (err) {
    console.error('[DB] Migration error on startup:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`Usage proxy listening on :${PORT}`);
  });
}

startServer();

module.exports = app;
