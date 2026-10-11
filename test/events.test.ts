import { describe, expect, it } from "vitest";

import { applyUsageEvent, type UsageEvent } from "../src/events.js";
import { debit, type DebitRequest } from "../src/ledger.js";
import { expectCharged, postDebit, seedWallet, shuffle, useLedger } from "./helpers.js";

describe("replayed events", () => {
  const ctx = useLedger();

  it("charges once per event when the whole batch is delivered three times, out of order", async () => {
    await seedWallet(ctx.pool, "acme", 100_000);
    const events: UsageEvent[] = Array.from({ length: 20 }, (_, i) => ({
      id: `evt-${i}`,
      walletId: "acme",
      amountCents: 100 + i,
      description: `alert ${i}`,
    }));
    const total = events.reduce((sum, event) => sum + event.amountCents, 0);

    const deliveries = shuffle([...events, ...events, ...events]);
    const results = await Promise.all(deliveries.map((event) => applyUsageEvent(ctx.pool, event)));

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.filter((r) => !r.replayed)).toHaveLength(20);
    await expectCharged(ctx.pool, "acme", 100_000, 20, total);

    const again = await Promise.all(events.map((event) => applyUsageEvent(ctx.pool, event)));
    expect(again.every((r) => r.replayed)).toBe(true);
    await expectCharged(ctx.pool, "acme", 100_000, 20, total);
  });

  it("rejects a key that comes back with a different amount", async () => {
    await seedWallet(ctx.pool, "acme", 10_000);
    const first: DebitRequest = {
      walletId: "acme",
      amountCents: 500,
      reference: "report",
      idempotencySource: "http",
      idempotencyKey: "k1",
    };

    expect((await debit(ctx.pool, first)).status).toBe(201);
    const changed = await debit(ctx.pool, { ...first, amountCents: 900 });

    expect(changed).toMatchObject({ status: 422, body: { error: "idempotency_key_reused" } });
    await expectCharged(ctx.pool, "acme", 10_000, 1, 500);
  });

  it("gives a key one outcome for good, including a refusal", async () => {
    await seedWallet(ctx.pool, "acme", 100);
    const request: DebitRequest = {
      walletId: "acme",
      amountCents: 500,
      reference: "report",
      idempotencySource: "http",
      idempotencyKey: "k1",
    };

    expect(await debit(ctx.pool, request)).toMatchObject({ status: 402, replayed: false });
    await ctx.pool.query(`UPDATE wallets SET balance_cents = 10_000 WHERE id = 'acme'`);

    expect(await debit(ctx.pool, request)).toMatchObject({ status: 402, replayed: true });
    expect(await debit(ctx.pool, { ...request, idempotencyKey: "k2" })).toMatchObject({
      status: 201,
    });
    await expectCharged(ctx.pool, "acme", 10_000, 1, 500);
  });

  it("does not keep a key for a wallet that does not exist", async () => {
    const request: DebitRequest = {
      walletId: "ghost",
      amountCents: 500,
      reference: "report",
      idempotencySource: "http",
      idempotencyKey: "k1",
    };

    expect((await debit(ctx.pool, request)).status).toBe(404);
    await seedWallet(ctx.pool, "ghost", 1_000);

    expect(await debit(ctx.pool, request)).toMatchObject({ status: 201, replayed: false });
    await expectCharged(ctx.pool, "ghost", 1_000, 1, 500);
  });

  it("keeps an HTTP key that looks like an event key apart from the real event", async () => {
    await seedWallet(ctx.pool, "acme", 10_000);

    // A client picks the same string the event consumer derives for event 42.
    const http = await postDebit(ctx.url, "acme", "event:42", 700);
    expect(http.status).toBe(201);
    expect(http.headers.get("idempotent-replayed")).toBe("false");

    const event = { id: "42", walletId: "acme", amountCents: 300, description: "alert 42" };
    expect(await applyUsageEvent(ctx.pool, event)).toMatchObject({
      status: 201,
      replayed: false,
      body: { amount_cents: 300, balance_after_cents: 9_000 },
    });

    expect(
      (await postDebit(ctx.url, "acme", "event:42", 700)).headers.get("idempotent-replayed"),
    ).toBe("true");
    expect(await applyUsageEvent(ctx.pool, event)).toMatchObject({ status: 201, replayed: true });
    await expectCharged(ctx.pool, "acme", 10_000, 2, 1_000);
  });
});
