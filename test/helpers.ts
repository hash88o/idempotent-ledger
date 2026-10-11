import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";

import { createPool, migrate } from "../src/db.js";
import { createApp } from "../src/server.js";

/** Give each test a migrated, empty database and an HTTP server on a free port. */
export function useLedger() {
  const ctx = {} as { pool: pg.Pool; url: string };
  let server: Server;

  beforeAll(async () => {
    ctx.pool = createPool();
    await migrate(ctx.pool);
    server = createApp(ctx.pool).listen(0);
    ctx.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await ctx.pool.query(
      "TRUNCATE ledger_entries, idempotency_keys, wallets RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await ctx.pool.end();
  });

  return ctx;
}

export async function seedWallet(pool: pg.Pool, id: string, balanceCents: number): Promise<void> {
  await pool.query("INSERT INTO wallets (id, balance_cents) VALUES ($1, $2)", [id, balanceCents]);
}

type WalletStateRow = { balance: string; entries: number; charged: string; keys: number };

export async function walletState(pool: pg.Pool, id: string) {
  const { rows } = await pool.query<WalletStateRow>(
    `SELECT w.balance_cents::text AS balance,
            (SELECT count(*) FROM ledger_entries e WHERE e.wallet_id = w.id)::int AS entries,
            (SELECT coalesce(sum(amount_cents), 0)
               FROM ledger_entries e WHERE e.wallet_id = w.id)::text AS charged,
            (SELECT count(*) FROM idempotency_keys k WHERE k.wallet_id = w.id)::int AS keys
     FROM wallets w WHERE w.id = $1`,
    [id],
  );
  return {
    balance: Number(rows[0].balance),
    entries: rows[0].entries,
    charged: Number(rows[0].charged),
    keys: rows[0].keys,
  };
}

/** Assert the invariant every test ends on: the balance is the opening balance minus the ledger. */
export async function expectCharged(
  pool: pg.Pool,
  id: string,
  opening: number,
  entries: number,
  charged: number,
) {
  const state = await walletState(pool, id);
  expect(state.entries).toBe(entries);
  expect(state.charged).toBe(charged);
  expect(state.balance).toBe(opening - charged);
}

export function postDebit(
  url: string,
  walletId: string,
  key: string,
  amountCents: number,
  reference = "report",
) {
  return fetch(`${url}/wallets/${walletId}/debits`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ amount_cents: amountCents, reference }),
  });
}

export function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
