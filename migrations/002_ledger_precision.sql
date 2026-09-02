-- 002: Widen ledger_entries.amount to 6 decimal places so sub-cent usage
-- deductions (e.g. $0.000006) are preserved exactly instead of rounding to
-- zero. cost_charged on usage_logs was already NUMERIC(14,6); the ledger's
-- original NUMERIC(14,4) silently dropped those tiny values.
ALTER TABLE ledger_entries
    ALTER COLUMN amount TYPE NUMERIC(16,6);
