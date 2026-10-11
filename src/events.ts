import type pg from "pg";

import { debit, type DebitResult } from "./ledger.js";

/** A billable event from a queue or a webhook, delivered at least once. */
export type UsageEvent = {
  id: string;
  walletId: string;
  amountCents: number;
  description: string;
};

/** Charge for an event once, however many times and in whatever order it is delivered. */
export function applyUsageEvent(pool: pg.Pool, event: UsageEvent): Promise<DebitResult> {
  return debit(pool, {
    walletId: event.walletId,
    amountCents: event.amountCents,
    reference: event.description,
    idempotencySource: "event",
    // The "event:" prefix is cosmetic. The source is what separates these keys from HTTP keys.
    idempotencyKey: `event:${event.id}`,
  });
}
