-- 003: Set active pricing rates margin to 0% for pilot/demo phase.
-- Revisit before real customer billing.
UPDATE pricing_rates
SET your_margin_pct = 0
WHERE effective_to IS NULL;
