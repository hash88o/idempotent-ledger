import { describe, expect, it } from "vitest";

import { debit, type DebitRequest, SimulatedCrash } from "../src/ledger.js";
import { expectCharged, seedWallet, useLedger, walletState } from "./helpers.js";

const request: DebitRequest = {
  walletId: "acme",
  amountCents: 2_500,
  reference: "monthly report",
  idempotencySource: "http",
  idempotencyKey: "invoice-42",
};

describe("retries after a crash", () => {
  const ctx = useLedger();

  it("crash before commit: nothing is charged, and the retry charges once", async () => {
    await seedWallet(ctx.pool, "acme", 10_000);

    // before_commit drops the connection mid-transaction, as a killed process would.
    await expect(debit(ctx.pool, request, { failpoint: "before_commit" })).rejects.toThrow(
      SimulatedCrash,
    );
    await expectCharged(ctx.pool, "acme", 10_000, 0, 0);
    expect((await walletState(ctx.pool, "acme")).keys).toBe(0);

    const retry = await debit(ctx.pool, request);
    expect(retry).toMatchObject({ status: 201, replayed: false });
    await expectCharged(ctx.pool, "acme", 10_000, 1, 2_500);
  });

  it("crash after commit: the charge stands, and the retry returns it instead of charging again", async () => {
    await seedWallet(ctx.pool, "acme", 10_000);

    // after_commit fails once the charge is durable, so the client never hears back.
    await expect(debit(ctx.pool, request, { failpoint: "after_commit" })).rejects.toThrow(
      SimulatedCrash,
    );
    await expectCharged(ctx.pool, "acme", 10_000, 1, 2_500);

    const retry = await debit(ctx.pool, request);
    expect(retry).toMatchObject({
      status: 201,
      replayed: true,
      body: { amount_cents: 2_500, balance_after_cents: 7_500 },
    });
    await expectCharged(ctx.pool, "acme", 10_000, 1, 2_500);
  });

  it("a crashing request and its retry running at the same time still charge once", async () => {
    await seedWallet(ctx.pool, "acme", 100_000);

    for (let round = 0; round < 10; round++) {
      const key = { ...request, idempotencyKey: `invoice-${round}` };
      await Promise.allSettled([
        debit(ctx.pool, key, { failpoint: "before_commit" }),
        debit(ctx.pool, key),
        debit(ctx.pool, key),
      ]);
    }

    await expectCharged(ctx.pool, "acme", 100_000, 10, 25_000);
  });
});
