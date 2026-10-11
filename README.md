# idempotent-ledger

A wallet debit endpoint that charges exactly once, however many times the request arrives. TypeScript, Express and Postgres.

This is a small, self-contained demonstration of a pattern I use in production billing code. It is written from scratch for this repository and shares no code with any employer.

## The problem

A client sends "debit this wallet 25.00" and the connection drops before the answer comes back. The client cannot tell whether the charge happened, so it retries. Three things can now go wrong:

1. **Concurrent duplicates.** The retry arrives while the first request is still running. Both read the balance, both subtract.
2. **Retry after a crash.** The server died partway. If it died after writing the charge, a naive retry charges twice. If it died before, a naive "already seen this key" check refuses a charge that never happened.
3. **Replayed events.** Charges driven by a queue or a webhook are delivered at least once, so the same event shows up again minutes or days later, possibly out of order.

The requirement in all three: **one logical request produces one ledger entry**, and every caller gets the same answer.

## The design

The caller sends an `Idempotency-Key` header. The whole debit runs in one Postgres transaction:

```
BEGIN
  1. claimKey       INSERT the key into idempotency_keys ... ON CONFLICT DO NOTHING
                      0 rows inserted -> someone already finished this request:
                                         read their stored answer, return it, stop.
  2. charge         UPDATE wallets SET balance = balance - amount
                      WHERE id = ? AND balance >= amount
  3. recordEntry    INSERT the ledger entry
  4. storeResponse  UPDATE idempotency_keys with the response we are about to send
COMMIT
```

`debit()` in [`src/ledger.ts`](src/ledger.ts) calls the four helpers in this order and owns `BEGIN`, `COMMIT` and `ROLLBACK`, so the whole transaction reads in one place. The schema is in [`sql/schema.sql`](sql/schema.sql).

### Why each choice

**The key claim is an `INSERT`, not a `SELECT` followed by an `INSERT`.**
"Check whether the key exists, then insert it" has a gap between the two statements, and two concurrent requests both pass the check. A primary key on `(wallet_id, source, key)` closes the gap: Postgres makes the second `INSERT` wait for the first transaction to finish. If the first commits, the second inserts nothing and reads the stored answer. If the first rolls back, the second takes over. The database does the locking, so there is no lock for the application to forget to release.

**The charge and the stored answer commit together.**
This is what makes a crash safe at any point. The process can die before `COMMIT`, in which case the balance change, the ledger entry and the key all roll back and the retry starts clean. Or it can die after `COMMIT`, in which case all three exist and the retry returns the stored answer. There is no state where the charge exists but the key does not, or the other way round. Designs that keep the key in Redis and the charge in the database cannot offer this, because the two writes can be torn apart by a crash.

**The balance check and the decrement are one statement.**
`UPDATE ... WHERE balance_cents >= $amount` takes the row lock, re-checks the condition against the latest committed balance, and subtracts. Reading the balance in application code and writing it back would let two requests with different keys spend the same money. A `CHECK (balance_cents >= 0)` constraint is the backstop if the application is ever wrong.

**A key is bound to its request body.**
The key row stores a hash of the wallet, amount and reference. If the same key comes back with a different amount, the answer is `422 idempotency_key_reused`, not a silent replay of the old charge. A reused key with different contents is a client bug, and it should be loud.

**A refusal is also a final answer.**
If the wallet has insufficient funds, the `402` is stored under the key like any other outcome. The same key returns `402` forever, even after a top-up. A retry of one attempt always gives one answer; a new attempt needs a new key. The alternative (not storing failures) means the outcome of a retry depends on timing, which is the thing idempotency keys exist to prevent.

**An unknown wallet does not consume the key.**
A `404` charges nothing and protects nothing, so the transaction rolls back and the key is free. This is the one deliberate exception to the rule above.

**The ledger is append-only, with its own unique constraint.**
`ledger_entries` has `UNIQUE (wallet_id, idempotency_source, idempotency_key)`. It is never the mechanism that stops a duplicate (step 1 is), but if step 1 were ever removed or bypassed, the insert would fail instead of double charging.

**Money is integer cents in `bigint`.**
No floating point, so no rounding drift.

**Event consumers derive the key from the event id.**
[`src/events.ts`](src/events.ts) charges for a usage event with the key `event:<id>`. The producer can redeliver any event, any number of times, in any order.

**HTTP keys and event keys live in separate namespaces.**
Every key row records its `source` (`http` or `event`), and the source is part of the primary key. A client is free to send `Idempotency-Key: event:42`, and it cannot claim real event 42's key, or be answered with event 42's charge. The separation is structural rather than a check on the key's prefix. A prefix check is a rule every new caller has to remember, and a new key format can slip past it. The `event:` prefix on event keys is kept only for readability; the `source` column is what separates the namespaces.

### What this does not cover

- **Key expiry.** Keys are kept forever here. A production system would delete them after a retention window with a scheduled job. Stripe, for example, expires keys after 24 hours.
- **Lock waits.** A duplicate request waits on the first request's row lock, holding a pool connection while it waits. A storm of duplicates behind one slow request can exhaust the pool. In production, set a short `lock_timeout` and answer `409` "request in progress" when it fires, which is the status the IETF `Idempotency-Key` header draft specifies for this case.
- **Amounts above 2^53 cents.** Postgres stores money as `bigint`, but the code converts it to a JavaScript `Number`, which is exact only below 2^53 cents (about 90 trillion in currency units). Larger values would need `BigInt` or string handling.
- **Calls to external systems inside the transaction.** If the debit also had to call a payment provider, that call cannot be rolled back with the transaction. It needs its own idempotency key passed to the provider, or an outbox table.
- **Credits and refunds.** Only debits are implemented. They would follow the same shape.
- **Isolation level.** The code relies on Postgres's default `READ COMMITTED`. Under it, the `UPDATE` in step 2 re-evaluates its `WHERE` clause after waiting for a row lock, which is what makes the single-statement balance check correct.

## Run it

Requirements: Node 20 or newer, and Docker.

```sh
npm install
npm run db:up        # Postgres 16 on localhost:54329
npm test
npm run db:down
```

`npm run lint` (ESLint) and `npm run format:check` (Prettier) run in CI too; `npm run format` fixes formatting.

To try the endpoint by hand:

```sh
npm run dev          # http://localhost:3000

curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"id":"acme","balance_cents":10000}'

# Run this twice. The second response has "Idempotent-Replayed: true"
# and the balance only moves once.
curl -si -X POST localhost:3000/wallets/acme/debits \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: invoice-42' \
  -d '{"amount_cents":2500,"reference":"monthly report"}'

curl -s localhost:3000/wallets/acme
```

## Tests

The tests run against a real Postgres, not a mock, because the guarantees come from the database. Every test ends by checking the same invariant: the number of ledger entries is what it should be, and the balance equals the opening balance minus the sum of the ledger.

| Scenario | Test | What it proves |
| :-- | :-- | :-- |
| Concurrent duplicates | 50 identical HTTP requests at once | One ledger entry. All 50 responses are identical, and exactly one is not a replay. |
| Concurrent spending | 30 different debits of 100 against a balance of 1,000 | Exactly 10 succeed and 20 get `402`. The balance ends at zero, never below. |
| Crash before commit | The connection is destroyed with the transaction open | Nothing is charged and the key is gone. The retry charges once. |
| Crash after commit | The request fails after `COMMIT`, so the client hears nothing | The charge stands. The retry returns it as a replay. |
| Crash racing its retries | A crashing request and two retries start together, 10 rounds | One charge per round. |
| Replayed events | 20 events delivered 3 times, shuffled, concurrently, then once more | 20 charges. |
| Key reuse | Same key, different amount | `422`, no second charge. |
| Stored refusal | `402`, then a top-up, then the same key | Still `402`. A new key succeeds. |
| Unknown wallet | `404`, then the wallet is created, then the same key | The key was not consumed. One charge. |
| Key namespaces | HTTP key `event:42`, then real event 42, then both again | Two independent charges. Each replays its own answer. |

The "crash" is simulated by closing the database socket without sending `COMMIT` or `ROLLBACK`. That is what Postgres sees when a process is killed, and it aborts the transaction the same way.

Last local run (Node 26, Postgres 16):

```
 ✓ concurrent requests > charges once when 50 identical requests arrive at the same time
 ✓ concurrent requests > never overdraws when different requests race for the same balance
 ✓ concurrent requests > requires an idempotency key
 ✓ retries after a crash > crash before commit: nothing is charged, and the retry charges once
 ✓ retries after a crash > crash after commit: the charge stands, and the retry returns it instead of charging again
 ✓ retries after a crash > a crashing request and its retry running at the same time still charge once
 ✓ replayed events > charges once per event when the whole batch is delivered three times, out of order
 ✓ replayed events > rejects a key that comes back with a different amount
 ✓ replayed events > gives a key one outcome for good, including a refusal
 ✓ replayed events > does not keep a key for a wallet that does not exist
 ✓ replayed events > keeps an HTTP key that looks like an event key apart from the real event

 Test Files  3 passed (3)
      Tests  11 passed (11)
```

CI runs the type check, lint, format check and the same tests on every push, against a Postgres service container: see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Layout

```
sql/schema.sql        three tables: wallets, ledger_entries, idempotency_keys
src/ledger.ts         debit(): the transaction described above
src/events.ts         charging for at-least-once events
src/server.ts         Express routes and input validation
src/db.ts, main.ts    pool, migration, entry point
test/                 concurrent, crash and replay scenarios
```
