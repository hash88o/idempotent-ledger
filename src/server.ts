import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type pg from "pg";

import { debit } from "./ledger.js";

const MAX_AMOUNT_CENTS = 1_000_000_000_00;
const MAX_WALLET_ID_LENGTH = 100;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MAX_REFERENCE_LENGTH = 200;

type CreateWalletBody = { id?: unknown; balance_cents?: unknown };
type DebitBody = { amount_cents?: unknown; reference?: unknown };

function isAmount(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_AMOUNT_CENTS
  );
}

function isBalance(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/** Build the HTTP app without listening, so tests can bind it to a free port. */
export function createApp(pool: pg.Pool): Express {
  const app = express();
  app.use(express.json());

  app.post("/wallets", async (req, res) => {
    const { id, balance_cents: balance } = (req.body ?? {}) as CreateWalletBody;
    if (!isText(id, MAX_WALLET_ID_LENGTH) || !isBalance(balance)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const created = await pool.query(
      `INSERT INTO wallets (id, balance_cents) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [id, balance],
    );
    if (created.rowCount === 0) {
      res.status(409).json({ error: "wallet_exists" });
      return;
    }
    res.status(201).json({ wallet_id: id, balance_cents: balance });
  });

  app.get("/wallets/:id", async (req, res) => {
    const found = await pool.query<{ balance: string; entries: number }>(
      `SELECT w.balance_cents::text AS balance,
              (SELECT count(*) FROM ledger_entries e WHERE e.wallet_id = w.id)::int AS entries
       FROM wallets w WHERE w.id = $1`,
      [req.params.id],
    );
    if (found.rowCount === 0) {
      res.status(404).json({ error: "wallet_not_found" });
      return;
    }
    res.json({
      wallet_id: req.params.id,
      balance_cents: Number(found.rows[0].balance),
      entries: found.rows[0].entries,
    });
  });

  app.post("/wallets/:id/debits", async (req, res) => {
    const key = req.get("Idempotency-Key");
    if (!isText(key, MAX_IDEMPOTENCY_KEY_LENGTH)) {
      res.status(400).json({ error: "idempotency_key_required" });
      return;
    }
    const { amount_cents: amountCents, reference } = (req.body ?? {}) as DebitBody;
    if (!isAmount(amountCents) || !isText(reference, MAX_REFERENCE_LENGTH)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const result = await debit(pool, {
      walletId: req.params.id,
      amountCents,
      reference,
      idempotencySource: "http",
      idempotencyKey: key,
    });
    res.set("Idempotent-Replayed", String(result.replayed));
    res.status(result.status).json(result.body);
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express needs 4 params here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
