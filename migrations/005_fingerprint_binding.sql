-- 005: Machine-fingerprint binding.
--
-- Each self-hosted agent-gateway install binds a machine fingerprint to its
-- instance row at activation time. Instances are the per-install row, so the
-- hash lives here (a customer may own many instances, each on its own machine).
--
-- Only a SHA-256 hash is stored -- never a raw hardware identifier. Hash lives
-- in fingerprint_hash; fingerprint_bound_at records when it was last set
-- (activation or operator rebind) so support can see drift.

ALTER TABLE instances
    ADD COLUMN fingerprint_hash      TEXT,
    ADD COLUMN fingerprint_bound_at  TIMESTAMPTZ;

-- Lookup path: an authenticated request carries X-Instance-Fingerprint and the
-- middleware compares it against the instance's stored hash.
CREATE INDEX idx_instances_fingerprint ON instances (fingerprint_hash)
    WHERE fingerprint_hash IS NOT NULL;