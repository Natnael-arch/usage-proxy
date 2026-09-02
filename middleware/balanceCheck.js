// Balance check middleware: runs AFTER auth (needs req.customer_id). Rejects
// the request with 402 before any upstream spend if the customer's ledger
// balance is at or below the minimum threshold. Cheap insurance, not a hold.
const { getBalance } = require('../services/balanceService');

const MIN_BALANCE_THRESHOLD = Number(
  process.env.MIN_BALANCE_THRESHOLD !== undefined
    ? process.env.MIN_BALANCE_THRESHOLD
    : 0
);

async function checkBalance(req, res, next) {
  let balance;
  try {
    balance = await getBalance(req.customer_id);
  } catch (err) {
    console.error('Balance check failed:', err.message);
    return res.status(500).json({ error: 'Internal error during balance check' });
  }

  if (balance <= MIN_BALANCE_THRESHOLD) {
    return res.status(402).json({
      error: 'insufficient_balance',
      balance,
      min_balance_threshold: MIN_BALANCE_THRESHOLD,
    });
  }

  // Useful for logging/debugging downstream.
  req.balance = balance;
  return next();
}

module.exports = { checkBalance };