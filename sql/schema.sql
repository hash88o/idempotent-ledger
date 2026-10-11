-- Money is integer cents in bigint, so there is no floating-point rounding.

CREATE TABLE IF NOT EXISTS wallets (
  id            text   PRIMARY KEY,
  -- The database refuses an overdraft even if the application has a bug.
  balance_cents bigint NOT NULL CHECK (balance_cents >= 0)
);

-- Append-only: rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id           text        NOT NULL REFERENCES wallets (id),
  amount_cents        bigint      NOT NULL CHECK (amount_cents > 0),
  reference           text        NOT NULL,
  idempotency_source  text        NOT NULL CHECK (idempotency_source IN ('http', 'event')),
  idempotency_key     text        NOT NULL,
  balance_after_cents bigint      NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Second line of defence: one key can never produce two entries.
  UNIQUE (wallet_id, idempotency_source, idempotency_key)
);

-- The primary key makes a duplicate request wait for the first one, then read its stored answer.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  wallet_id    text        NOT NULL,
  -- Separate namespaces, so an HTTP key "event:42" cannot collide with event 42.
  source       text        NOT NULL CHECK (source IN ('http', 'event')),
  key          text        NOT NULL,
  request_hash text        NOT NULL,
  -- Set before COMMIT, so no other transaction ever sees them empty.
  status       integer,
  body         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_id, source, key)
);
