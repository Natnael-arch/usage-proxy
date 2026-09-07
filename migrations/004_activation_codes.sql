-- 004: Activation codes for onboarding. A staff/admin generates a random
-- activation code (stored hashed, never plaintext) tied to a customer +
-- instance pair. The self-hosted agent-gateway exchanges that code ONCE for a
-- real auth token via POST /v1/activate.

CREATE TABLE activation_codes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(id),
    instance_id     UUID NOT NULL REFERENCES instances(id),
    code_hash       TEXT NOT NULL UNIQUE,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    used_token_id   UUID REFERENCES auth_tokens(id)
);

CREATE INDEX idx_activation_codes_code_hash ON activation_codes (code_hash);
