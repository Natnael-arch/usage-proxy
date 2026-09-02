-- 001: Initial schema -- customers, instances, auth_tokens, pricing_rates,
-- usage_logs, ledger_entries.

-- Customers: the B2B org that owns one or more agent-gateway instances.
CREATE TABLE customers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    contact_email   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes           TEXT
);

-- Instances: one self-hosted agent-gateway per B2B deployment site.
CREATE TABLE instances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(id),
    label           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ
);

-- Auth tokens: hashed bearer tokens used to authenticate each instance.
-- Only the SHA-256 hash of the token is stored; never the plaintext.
CREATE TABLE auth_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id     UUID NOT NULL REFERENCES instances(id),
    token_hash      TEXT NOT NULL UNIQUE,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    revoked_reason  TEXT
);

-- Pricing rates: provider/route cost inputs and margin. Reserved for later
-- phases (metering/billing). Created now so Phase 1 needn't be revisited.
CREATE TABLE pricing_rates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider            TEXT NOT NULL,
    model_or_route      TEXT NOT NULL,
    input_cost_per_1k   NUMERIC(10,6) NOT NULL,
    output_cost_per_1k  NUMERIC(10,6) NOT NULL,
    your_margin_pct     NUMERIC(5,2) NOT NULL DEFAULT 0,
    effective_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to        TIMESTAMPTZ
);

-- Usage logs: per-request metering records. Reserved for later phases.
CREATE TABLE usage_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL REFERENCES customers(id),
    instance_id         UUID NOT NULL REFERENCES instances(id),
    provider            TEXT NOT NULL,
    route               TEXT NOT NULL,
    pricing_rate_id     UUID REFERENCES pricing_rates(id),
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    cost_charged        NUMERIC(14,6) NOT NULL,
    latency_ms          INTEGER NOT NULL,
    status              TEXT NOT NULL,
    error_detail        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ledger entries: financial swings per customer. Reserved for later phases.
CREATE TABLE ledger_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(id),
    amount          NUMERIC(14,4) NOT NULL,
    entry_type      TEXT NOT NULL,
    related_usage_log_id UUID REFERENCES usage_logs(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    note            TEXT
);

-- Indexes for the common query paths.
CREATE INDEX idx_usage_logs_customer_time ON usage_logs (customer_id, created_at);
CREATE INDEX idx_usage_logs_instance_time ON usage_logs (instance_id, created_at);
CREATE INDEX idx_ledger_customer_time ON ledger_entries (customer_id, created_at);
CREATE INDEX idx_auth_tokens_hash ON auth_tokens (token_hash);
