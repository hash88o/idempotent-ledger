import { describe, expect, it } from "vitest";

import { expectCharged, postDebit, seedWallet, useLedger } from "./helpers.js";

describe("concurrent requests", () => {
  const ctx = useLedger();

  it("charges once when 50 identical requests arrive at the same time", async () => {
    await seedWallet(ctx.pool, "acme", 10_000);

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => postDebit(ctx.url, "acme", "invoice-42", 2_500)),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));

    expect(responses.map((r) => r.status)).toEqual(Array(50).fill(201));
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(responses.filter((r) => r.headers.get("idempotent-replayed") === "false")).toHaveLength(
      1,
    );
    expect(bodies[0]).toMatchObject({ amount_cents: 2_500, balance_after_cents: 7_500 });

    await expectCharged(ctx.pool, "acme", 10_000, 1, 2_500);
  });

  it("never overdraws when different requests race for the same balance", async () => {
    await seedWallet(ctx.pool, "acme", 1_000);

    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) => postDebit(ctx.url, "acme", `job-${i}`, 100)),
    );
    const statuses = responses.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 402)).toHaveLength(20);
    await expectCharged(ctx.pool, "acme", 1_000, 10, 1_000);
  });

  it("requires an idempotency key", async () => {
    await seedWallet(ctx.pool, "acme", 1_000);
    const response = await fetch(`${ctx.url}/wallets/acme/debits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 100, reference: "report" }),
    });
    expect(response.status).toBe(400);
    await expectCharged(ctx.pool, "acme", 1_000, 0, 0);
  });
});
