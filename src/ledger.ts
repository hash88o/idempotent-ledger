import { createHash } from "node:crypto";

import type pg from "pg";

/** Keys are unique per (wallet, source), so an HTTP key never collides with an event key. */
export type KeySource = "http" | "event";

export type DebitRequest = {
  walletId: string;
  amountCents: number;
  reference: string;
  idempotencySource: KeySource;
  idempotencyKey: string;
};

export type DebitResult = {
  status: 201 | 402 | 404 | 422;
  body: Record<string, unknown>;
  /** True when the answer was stored by an earlier request with the same key. */
  replayed: boolean;
};

/** Test-only: the point at which to simulate the process dying. */
export type Failpoint = "before_commit" | "after_commit";

export class SimulatedCrash extends Error {
  constructor(public readonly at: Failpoint) {
    super(`simulated crash ${at}`);
  }
}

type StoredKey = {
  request_hash: string;
  status: DebitResult["status"];
  body: Record<string, unknown>;
};

type StoredResponse = { status: 201 | 402; body: Record<string, unknown> };

type ClaimOutcome = { kind: "claimed" } | { kind: "taken"; answer: DebitResult };

type ChargeOutcome =
  | { kind: "charged"; balanceAfter: number }
  | { kind: "insufficient_funds" }
  | { kind: "wallet_not_found" };

/** Charge a wallet at most once per idempotency key, and give every retry the stored answer. */
export async function debit(
  pool: pg.Pool,
  request: DebitRequest,
  options: { failpoint?: Failpoint } = {},
): Promise<DebitResult> {
  const client = await pool.connect();
  let destroyConnection = false;
  try {
    await client.query("BEGIN");

    const claim = await claimKey(client, request);
    if (claim.kind === "taken") {
      await client.query("ROLLBACK");
      return claim.answer;
    }

    const outcome = await charge(client, request);
    if (outcome.kind === "wallet_not_found") {
      // An unknown wallet charges nothing, so the key is released for a later retry.
      await client.query("ROLLBACK");
      return { status: 404, body: { error: "wallet_not_found" }, replayed: false };
    }

    const response: StoredResponse =
      outcome.kind === "charged"
        ? { status: 201, body: await recordEntry(client, request, outcome.balanceAfter) }
        : {
            status: 402,
            body: {
              error: "insufficient_funds",
              wallet_id: request.walletId,
              amount_cents: request.amountCents,
            },
          };
    await storeResponse(client, request, response);

    if (options.failpoint === "before_commit") {
      destroyConnection = true;
      throw new SimulatedCrash("before_commit");
    }
    await client.query("COMMIT");
    if (options.failpoint === "after_commit") {
      throw new SimulatedCrash("after_commit");
    }
    return { ...response, replayed: false };
  } catch (err) {
    if (!destroyConnection) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    // release(true) drops the socket without COMMIT or ROLLBACK, so Postgres aborts the
    // transaction exactly as it would if the process died.
    client.release(destroyConnection);
  }
}

// The primary key makes a concurrent duplicate wait here until the first request finishes.
// A taken key answers with the stored response, or 422. See README: "The key claim is an INSERT".
async function claimKey(client: pg.PoolClient, request: DebitRequest): Promise<ClaimOutcome> {
  const hash = requestHash(request);
  const claim = await client.query(
    `INSERT INTO idempotency_keys (wallet_id, source, key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wallet_id, source, key) DO NOTHING`,
    [request.walletId, request.idempotencySource, request.idempotencyKey, hash],
  );
  if (claim.rowCount !== 0) return { kind: "claimed" };

  const prior = await client.query<StoredKey>(
    `SELECT request_hash, status, body FROM idempotency_keys
     WHERE wallet_id = $1 AND source = $2 AND key = $3`,
    [request.walletId, request.idempotencySource, request.idempotencyKey],
  );
  const row = prior.rows[0];
  if (row.request_hash !== hash) {
    const body = {
      error: "idempotency_key_reused",
      message: "This key was already used for a different request.",
    };
    return { kind: "taken", answer: { status: 422, body, replayed: false } };
  }
  return { kind: "taken", answer: { status: row.status, body: row.body, replayed: true } };
}

// Binds a key to its request. See README: "A key is bound to its request body".
function requestHash(request: DebitRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([request.walletId, request.amountCents, request.reference]))
    .digest("hex");
}

// One statement checks and decrements, so two different keys cannot spend the same money.
async function charge(client: pg.PoolClient, request: DebitRequest): Promise<ChargeOutcome> {
  const updated = await client.query<{ balance: string }>(
    `UPDATE wallets SET balance_cents = balance_cents - $2
     WHERE id = $1 AND balance_cents >= $2
     RETURNING balance_cents::text AS balance`,
    [request.walletId, request.amountCents],
  );
  if (updated.rowCount !== 0) {
    return { kind: "charged", balanceAfter: Number(updated.rows[0].balance) };
  }
  const wallet = await client.query("SELECT 1 FROM wallets WHERE id = $1", [request.walletId]);
  return { kind: wallet.rowCount === 0 ? "wallet_not_found" : "insufficient_funds" };
}

async function recordEntry(
  client: pg.PoolClient,
  request: DebitRequest,
  balanceAfter: number,
): Promise<Record<string, unknown>> {
  const entry = await client.query<{ id: string }>(
    `INSERT INTO ledger_entries
       (wallet_id, amount_cents, reference,
        idempotency_source, idempotency_key, balance_after_cents)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::text AS id`,
    [
      request.walletId,
      request.amountCents,
      request.reference,
      request.idempotencySource,
      request.idempotencyKey,
      balanceAfter,
    ],
  );
  return {
    entry_id: entry.rows[0].id,
    wallet_id: request.walletId,
    amount_cents: request.amountCents,
    reference: request.reference,
    balance_after_cents: balanceAfter,
  };
}

// Stored in the charge's transaction, so after a crash both exist or neither does.
async function storeResponse(
  client: pg.PoolClient,
  request: DebitRequest,
  response: StoredResponse,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys SET status = $4, body = $5
     WHERE wallet_id = $1 AND source = $2 AND key = $3`,
    [
      request.walletId,
      request.idempotencySource,
      request.idempotencyKey,
      response.status,
      JSON.stringify(response.body),
    ],
  );
}
