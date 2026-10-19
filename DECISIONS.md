# DECISIONS

Checkout & Rewards Service: Node.js + TypeScript + Express, in-memory store, one instance.
Code references are relative to `backend/src/`. Test IDs refer to `docs/TEST_PLAN.md` and `docs/EDGE_CASES.md`.

**Contents**

1. [System invariants](#1-system-invariants)
2. [Ambiguities and chosen semantics](#2-ambiguities-and-chosen-semantics)
3. [Material design decisions](#3-material-design-decisions) (13 decisions in 10 groups: Locks, Checkout flow, Idempotency, Backpressure and timeouts, Inventory and pricing, Money, Coupons, Persistence, Payment, API)
4. [Transaction, concurrency and idempotency strategy](#4-transaction-concurrency-and-idempotency-strategy)
5. [Money and rounding rules](#5-money-and-rounding-rules)
6. [Error model](#6-error-model)
7. [Implemented vs deferred](#7-implemented-vs-deferred)
8. [Multiple instances and production scale](#8-multiple-instances-and-production-scale)
9. [How I used AI tools](#9-how-i-used-ai-tools)
10. [With two more hours](#10-with-two-more-hours)

---

## 1. System invariants

| ID | Invariant | Enforced in | Proved by |
|---|---|---|---|
| I1 | Stock never goes below zero; sold + remaining = starting stock | `services/checkoutService.ts` (check under product lock) | X3, S1 |
| I2 | A cart becomes at most one order | cart lock + `status !== "OPEN"` check | K6, K17 |
| I3 | One Idempotency-Key produces at most one order | idempotency check before the first `await` | K12, K13 |
| I4 | A coupon is redeemed at most once, and only by a checkout that commits | coupon lock + status check + commit block | K18, K11 |
| I5 | A failed checkout changes nothing | all writes happen in the commit block, after every check and the payment | K11, X6, E4 |
| I6 | Coupons generated ≤ floor(placed orders / n); one coupon per milestone | `services/couponService.ts` | M1–M5 |
| I7 | Money is integer cents; 0 ≤ total ≤ subtotal | `domain/money.ts` | K19, K20, E6 |
| I8 | An order keeps the prices it charged | `OrderLine` snapshot | O3 |
| I9 | The report equals the stored orders and coupons, and reading it changes nothing | `services/reportService.ts` | R2, R4, H6 |

## 2. Ambiguities and chosen semantics

| Question the brief left open | Chosen semantics |
|---|---|
| Price changes after an item is added | The cart always shows current prices. The order charges the price at checkout. If the client sends `expectedSubtotalCents` and it differs, checkout returns `409 PRICE_CHANGED` and charges nothing. |
| Stock changes after an item is added | Adding to a cart does not reserve stock. Checkout re-checks stock and returns `409 INSUFFICIENT_INVENTORY` with requested and available per line. |
| What counts toward the n-th order | Successful orders only, one per checkout regardless of quantity. Orders that used a coupon still count. Failed and replayed checkouts do not. |
| When a coupon is created | When an admin calls `POST /admin/coupons`; one call creates the coupon for the earliest unrewarded milestone. |
| Who can use a coupon | Anyone holding the code (there are no accounts), once. No expiry, no minimum spend. The percentage is fixed when the coupon is generated. |
| What the discount applies to | The whole order subtotal, rounded half up to the cent, capped at the subtotal. |
| Order statuses | An order exists only after payment is approved and the commit succeeds, so its status is `CONFIRMED`. The cart moves `OPEN → CHECKED_OUT` once. |
| Same Idempotency-Key, different body | Rejected with `422 IDEMPOTENCY_KEY_REUSED`. "Same request" means same cart and same coupon. |
| Retry after a failed checkout | The key is released, so the same key is evaluated again (useful after fixing the cart). |
| Payment | A fake asynchronous gateway; see the Payment decision. |
| Admin authentication | Not implemented. Admin operations are those under `/admin/*`. |

## 3. Material design decisions

### Locks

#### Decision: In-process keyed mutex for cart, product and coupon

**Context:** Node runs one piece of JavaScript at a time, so code without `await` cannot interleave. Checkout must `await` the payment provider. During that wait another request runs: two checkouts can both see "1 in stock", both pay, and both commit.

**Options considered:**
1. One global lock around every checkout.
2. No locks; decrement at commit and fail if stock would go negative.
3. Optimistic concurrency: version numbers, retry on conflict.
4. A lock per resource (cart, product, coupon).

**Choice:** Option 4. `domain/keyedMutex.ts` keeps a FIFO promise queue per key (`cart:<id>`, `product:<id>`, `coupon:<code>`). Checkout holds the locks for its cart, products and coupon from validation until commit. Cart edits take the cart lock; admin price or stock changes take the product lock.

**Why:** Option 1 is correct but makes a mug purchase wait for an unrelated lamp purchase. Option 2 discovers the conflict after payment, so the loser needs a refund. Option 3 suits a database, but in memory it adds retry loops for no gain and gives no fairness. Per-key locks serialise only requests that touch the same thing, and serve them in arrival order.

**Consequences:** Unrelated checkouts run in parallel. A slow payment holds its product's lock, so shoppers queue behind it; there is no lock or payment timeout yet (deferred, Section 10). Locks live in process memory, so this only works with one instance (see Persistence).

#### Decision: Fixed lock order: cart first, then coupon and products sorted

**Context:** A checkout needs several locks. Two carts listing the same products in a different order could each hold one lock and wait forever for the other.

**Options considered:** acquire in cart order; acquire with a timeout and retry; acquire in one global order.

**Choice:** Take the cart lock alone first (the item list can only be read safely once the cart is locked), then take the coupon and product locks in one call that sorts the keys.

**Why:** A single global order makes a wait cycle impossible, with no timeouts or retries. The cart is locked first because the product set is only known after reading the locked cart.

**Consequences:** No deadlock by construction. Test X5 builds the exact deadlock schedule; it hangs when sorting is removed and passes with it.

### Checkout flow

#### Decision: Validate under the locks, then pay, then commit with no await

**Context:** A checkout touches stock, the coupon, the order list, the cart and the order counter. A crash between those writes, or another request observing them halfway, would break I1–I5.

**Options considered:**
1. Pay first, then validate and write.
2. Reserve stock, pay, then confirm or release.
3. Validate everything under the locks, pay, then write everything in one synchronous block.

**Choice:** Option 3 (`services/checkoutService.ts`): checks → price → `await payment` → one block with no `await` that decrements stock, redeems the coupon, stores the order, closes the cart, increments the counter, and stores the idempotency response.

**Why:** Option 1 charges customers who then lose the race. Option 2 needs a release path that must run exactly once, plus expiry timers. With Option 3, losers are refused before payment (no refunds, test E4). After an approved payment the commit cannot fail, because everything was validated and nothing else can run until it finishes.

**Consequences:** No partial writes and no refund path. Every error before the commit leaves state untouched. The cost is that locks are held across the payment call (see Locks).

### Idempotency

#### Decision: Required Idempotency-Key on checkout, released on failure

**Context:** Clients retry after timeouts. A retry must not create a second order or take stock twice.

**Options considered:**
1. Deduplicate by cart only (a cart can become one order).
2. Client-supplied Idempotency-Key that stores only successes.
3. Idempotency-Key that stores every response, including failures.

**Choice:** Option 2, plus the cart rule from Option 1. Checkout requires `Idempotency-Key` (8–100 characters, `A-Z a-z 0-9 . _ : -`). Before the first `await`, the key is claimed as `IN_PROGRESS` together with a fingerprint (cart id + normalised coupon). On success the 201 response is stored and replayed with `Idempotent-Replayed: true`. On any failure the key is deleted.

**Why:** The cart rule alone cannot return the original response to a client that lost it. Storing failures (Option 3) would replay "out of stock" forever, even after the customer fixed the cart. Claiming the key synchronously means two identical requests cannot both claim it. The character rule rejects two headers that Node would join into one `"a, b"` key.

**Consequences:**

| Situation | Response |
|---|---|
| Same key, still running | `409 REQUEST_IN_PROGRESS` |
| Same key, completed | The stored 201 |
| Same key, different cart or coupon | `422 IDEMPOTENCY_KEY_REUSED` |
| New key, cart already checked out | `409 CART_ALREADY_CHECKED_OUT` with the existing `orderId` |

Keys never expire (deferred). Tests: K12–K15, K23, E2, X8.

### Backpressure and timeouts

#### Decision: Bound every wait: lock-wait timeout, payment timeout, key expiry

**Context:** A load test (`scripts/load-test.ts`: 100 shoppers, 150 ms simulated payment) passed every invariant but showed checkout p95 latency of 6 s and about 8 orders/s. The cause is Decision "Validate under the locks, then pay": a checkout holds its products' locks while it awaits payment, so shoppers for the same product are served one at a time. Throughput per product is about 1 / payment latency; with a real provider near 1 s that is about one order per second per hot product. Three risks followed: the queue behind a slow checkout has no limit, a provider that never answers would hold a product's lock forever, and completed idempotency keys were never freed.

**Options considered:**
1. Leave the waits unbounded.
2. Reserve stock in a synchronous block, release the product locks, pay, then confirm or restore the stock. This removes the queue.
3. Keep the design and bound each wait.

**Choice:** Option 3:

| Protection | Setting | Behaviour |
|---|---|---|
| Lock-wait timeout | `LOCK_WAIT_MS`, default 10 s | A request still waiting gives up with `503 SERVER_BUSY` and `Retry-After: 2`. Nothing is written, it is never charged, its key is freed. |
| Payment timeout | `PAYMENT_TIMEOUT_MS`, default 15 s | `504 PAYMENT_TIMEOUT`. Nothing is written, locks and key are released. The Idempotency-Key is forwarded to the provider so a real provider can dedupe a retry. |
| Key expiry | `IDEMPOTENCY_TTL_MS`, default 24 h | Completed keys are swept lazily, at most once a minute. A late retry of an expired key still cannot duplicate: the cart is `CHECKED_OUT`, so it gets `409 CART_ALREADY_CHECKED_OUT` with the existing `orderId`. |

The browser retries `SERVER_BUSY` and `REQUEST_IN_PROGRESS` up to twice with the same key.

**Why:** Option 2 is the right production step, but it changes what shoppers see. While a payment is in flight its units are already taken, so a second shopper is refused even if the first payment then fails (today test X9 shows the second shopper gets the unit). It also needs a release step that runs exactly once, for both stock and the coupon. That is not worth the risk for a demo-scale service whose correctness argument is simplest when nothing is written before payment succeeds. Bounding the waits gives backpressure without touching that argument. Evidence from the same load script with 250 shoppers and `LOCK_WAIT_MS=3000`: checkout p95 3.0 s (max 3.3 s) instead of a queue that keeps growing, 175 requests shed with 503, zero 5xx, every invariant still passing, throughput unchanged at 8.9 orders/s.

**Consequences:** Under a burst some shoppers get 503 and must retry. Throughput per hot product is still capped by payment latency; Option 2 is the fix when that matters (Section 10). A 504 leaves the real outcome unknown with a real provider, so reconciliation (outbox plus a status check) is deferred (Section 7). The mutex hands an abandoned place in line on to the next waiter; without that, one timed-out request would block the product forever (test T2). Tests: T1–T8, L1–L3.

### Inventory and pricing

#### Decision: No stock reservation in the cart

**Context:** The brief requires never overselling and asks what happens when availability changes before checkout.

**Options considered:** reserve stock when added to a cart; reserve stock for a few minutes at checkout start; reserve nothing and check at checkout.

**Choice:** Reserve nothing. `PUT` refuses quantities above current stock as early feedback; checkout re-checks under the lock.

**Why:** Cart reservations let abandoned carts hide stock from real buyers and need expiry and release logic. With validate-then-pay (see Checkout flow), checking at checkout is enough to never oversell, and losers are not charged.

**Consequences:** Ten shoppers can each hold the last 3 units in their carts (X1); only checkout decides. A shopper can be refused at checkout after filling the cart. That is acceptable here; a short checkout-time reservation is the upgrade path.

#### Decision: Charge the price at checkout, guarded by expectedSubtotalCents

**Context:** An admin can change a price while a customer has the old page open.

**Options considered:** freeze the price when the item is added; always charge the current price silently; charge the current price but let the client assert what it showed.

**Choice:** Orders use the price at checkout and store it in an `OrderLine` snapshot. The client may send `expectedSubtotalCents`. If it differs from the current subtotal (up or down), checkout returns `409 PRICE_CHANGED` with old and new values and charges nothing. Admin price changes take the product lock, so they cannot land between validation and commit.

**Why:** Freezing prices in the cart means honouring stale prices indefinitely. Silent repricing charges an amount the customer never saw. The assertion keeps the server authoritative while making the change visible.

**Consequences:** The UI reloads the cart and asks the customer to confirm (E7, E9). API clients that omit the field get the current price (E8). Orders stay explainable after later price changes (O3).

### Money

#### Decision: Integer cents with one half-up rounding step

**Context:** Totals must be exact and deterministic; floats drift (`0.1 + 0.2 ≠ 0.3`).

**Options considered:** JavaScript numbers in dollars; a decimal library; integer cents.

**Choice:** All amounts are integer cents. The only rounding is the discount, computed as `floor((subtotal × percent + 50) / 100)`, capped at the subtotal. See Section 5.

**Why:** Integer arithmetic is exact at these magnitudes and needs no dependency. One rounding point means one rule to explain and test.

**Consequences:** Every API field ends in `Cents`; the UI formats for display. A decimal type is only needed if fractional cents (tax rates, FX) appear.

### Coupons

#### Decision: Admin-triggered coupon per milestone, counted from successful orders

**Context:** "Every n-th successfully placed order makes one coupon available", generated on admin request, at most once per milestone.

**Options considered:**
1. Apply the discount automatically to the n-th order.
2. Create the coupon automatically when the n-th order commits.
3. Admin generates the coupon for the earliest unrewarded milestone.

**Choice:** Option 3 (`services/couponService.ts`). Milestones reached = floor(placedOrders / n). Owed = reached − generated. One call creates one coupon (`SAVE{x}-XXXXXX`, unique, `percentOff` fixed at creation) or returns `409 NO_ELIGIBLE_MILESTONE` with `nextMilestoneAtOrder`.

**Why:** The brief explicitly describes an administrator requesting generation. Option 1 contradicts "makes a coupon available". Generation has no `await`, so concurrent admin calls cannot both create the coupon for the same milestone (M5). Deriving "owed" from counts makes "one per milestone" hold without extra bookkeeping.

**Consequences:** If the admin is late, several milestones can be owed; each call rewards the earliest (M4). Splitting one purchase into n small orders unlocks a coupon sooner. That is acceptable without accounts; per-customer counting needs authentication.

### Persistence

#### Decision: In-memory store, exactly one instance

**Context:** The brief allows in-memory storage if invariants still hold under overlapping requests, and asks how a production design would differ.

**Options considered:** SQLite; PostgreSQL; in-memory Maps.

**Choice:** In-memory Maps (`store.ts`), seeded from `data/products.json`. The deployment (`render.yaml`) pins one instance.

**Why:** No setup or credentials for reviewers, fast deterministic tests, and the concurrency problem stays visible in code (locks) instead of hidden inside a database. The tests prove the invariants under real overlapping HTTP requests.

**Consequences:** A restart or redeploy wipes all data, including idempotency keys, so a retry after a restart would be treated as new. Two instances would each have their own stock and locks and could oversell. Section 8 covers the move to a database.

### Payment

#### Decision: Fake asynchronous payment gateway

**Context:** No real payment integration is required, but the design must survive payment being slow or failing.

**Options considered:** treat checkout as payment success (no step at all); a synchronous stub; an asynchronous fake behind an interface.

**Choice:** `domain/payment.ts` defines `PaymentGateway` with a `FakePaymentGateway` that waits `PAYMENT_DELAY_MS` (default 150 ms), records every charge, and can be told to decline (`declineNext`).

**Why:** With no payment step there is no `await` in checkout, which hides the race the brief asks about. The asynchronous fake recreates the real window in which other requests run, and makes declines and "who was charged" testable (X9, E4).

**Consequences:** A real provider can replace the fake behind the same interface. Timeouts, webhooks, duplicate callbacks and refunds are not modelled (deferred).

### API

#### Decision: PUT sets the item quantity (no "add 1" endpoint)

**Context:** Customers double-click "Add", and clients retry requests.

**Options considered:** `POST /items` that increments; `PUT /items/{productId}` with an absolute quantity.

**Choice:** `PUT /carts/{id}/items/{productId}` with `{ quantity: 1-99 }`, which adds the line or replaces its quantity. `DELETE` removes it.

**Why:** A retried "add one" adds twice; a retried "set to 2" is harmless. To keep deliberate rapid clicks from being lost, the UI disables "Add" until the previous update returns.

**Consequences:** Cart edits are idempotent (X12, E3). The client must know the current quantity, which it always has from the last cart response.

#### Decision: One error envelope with stable codes

**Context:** Errors must be distinguishable and useful to an API client.

**Options considered:** HTTP status plus a free-text message; RFC 7807 problem details; a custom envelope with a stable code.

**Choice:** Every error is `{ error: { code, message, details } }` with 24 codes (`domain/errors.ts`). See Section 6.

**Why:** Clients branch on a stable `code`; `details` carries what they need to act, such as `available` per line or the existing `orderId`. It is simpler than RFC 7807 and carries the same information.

**Consequences:** Adding a failure means adding a code and documenting it in `docs/ERRORS.md`. Client mistakes never surface as 500 (fixed: oversized body → 413, malformed URL → 400).

---

## 4. Transaction, concurrency and idempotency strategy

How the decisions above combine on `POST /carts/{id}/checkout`:

| Step | Action | Decision |
|---|---|---|
| 1 | Validate header and body | Error model |
| 2 | Claim the Idempotency-Key synchronously (replay, 409 or 422 if already used) | Idempotency |
| 3 | Lock the cart; check it is open and not empty | Locks, lock order |
| 4 | Lock the coupon and products (sorted); check stock, coupon, price assertion | Locks, inventory and pricing |
| 5 | `await` payment | Payment |
| 6 | Commit every write in one block with no `await`; store the response under the key | Checkout flow |
| 7 | `finally`: release locks. On error the key is deleted and nothing was written | Checkout flow, idempotency |

| Other operation | Protection |
|---|---|
| Cart add / change / remove | Cart lock: waits for an in-flight checkout, then sees `CHECKED_OUT` (K21) |
| Admin price / stock change | Product lock: applies after an in-flight checkout commits (K24, X11) |
| Coupon generation | No `await`, so it cannot interleave (M5) |
| Report and order history | Read-only; computed from committed orders only (R4, H4) |

**Verification:** 124 automated tests run against a real HTTP server per test. With locks disabled, the race tests fail (X3, X4, X11, X13, X14, K16–K18, K21, S1, L1, L2). With lock sorting removed, X5 deadlocks. Removing each timeout or the key sweep fails T1, T2, T3b, T4 or T6. `npm run edge-cases` runs 37 checks and `npm run load` a concurrent-shoppers scenario against a live server.

**Measured behaviour** (`npm run load`, laptop, 150 ms simulated payment; stock conservation, order counts, revenue, coupon counts and status codes all checked):

| Run | Shoppers | `LOCK_WAIT_MS` | Orders | Checkout p50 / p95 / max | Shed (503) | 5xx |
|---|---|---|---|---|---|---|
| A | 100 | 10 s | 81 (8.0/s) | 1.2 s / 6.3 s / 6.3 s | 0 | 0 |
| B | 250 | 3 s | 63 (8.9/s) | 3.0 s / 3.0 s / 3.3 s | 175 | 0 |

All invariants held in both runs. Latency grows with the number of shoppers per product (they are served one at a time) and is capped by the lock-wait timeout.

## 5. Money and rounding rules

| Rule | Detail |
|---|---|
| Unit | Integer cents everywhere (`priceCents`, `subtotalCents`, `discountCents`, `totalCents`) |
| Line total | `unitPriceCents × quantity` |
| Subtotal | Sum of line totals, at prices current at checkout |
| Discount | `floor((subtotal × percent + 50) / 100)`: percent of subtotal, rounded half up, once, on the whole order |
| Cap | `discount = min(discount, subtotal)`, so `total = subtotal − discount ≥ 0` |
| Percent | Integer 1–100, from `COUPON_PERCENT_OFF`, fixed on the coupon when generated |
| Examples | $10.05 at 10% → $1.01 off; $10.04 → $1.00; $99.98 → $10.00; 100% → total $0.00 |
| Report | Gross = Σ subtotals; discounts = Σ discounts; net = gross − discounts = Σ totals charged |

## 6. Error model

| Status | Used for |
|---|---|
| 400 | Malformed or invalid request: `VALIDATION_ERROR`, `INVALID_JSON`, `BAD_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED` |
| 402 | `PAYMENT_DECLINED` |
| 404 | Missing cart, product, order, coupon, line or route |
| 409 | Valid request that conflicts with current state: `INSUFFICIENT_INVENTORY`, `CART_ALREADY_CHECKED_OUT`, `COUPON_ALREADY_REDEEMED`, `PRICE_CHANGED`, `REQUEST_IN_PROGRESS`, `NO_ELIGIBLE_MILESTONE` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | Well-formed but meaningless: `CART_EMPTY`, `IDEMPOTENCY_KEY_REUSED` |
| 503 | `SERVER_BUSY`: waited longer than `LOCK_WAIT_MS` for a lock; sends `Retry-After: 2` |
| 504 | `PAYMENT_TIMEOUT`: the provider did not answer within `PAYMENT_TIMEOUT_MS` |
| 500 | Unexpected server errors only |

Checkout returns the first failing check, in a fixed order, and writes nothing. The full catalogue (when each code occurs, its `details`, what a client should do) is in `docs/ERRORS.md`.

## 7. Implemented vs deferred

| Area | Implemented | Deferred, and why |
|---|---|---|
| Catalog | 6 seeded products; admin price and stock edits | Create / deactivate products (not in the brief) |
| Cart | Create, view with live prices and stock warnings, set quantity, remove | Cart expiry |
| Checkout | Idempotent, locked, validate → pay → commit, price-change guard, bounded lock wait (503), payment timeout (504) | Reserve-then-pay to lift the per-product throughput limit (Section 10) |
| Orders | Snapshot lines, `CONFIRMED` status, `GET /orders/{id}`, paginated `GET /admin/orders` | Shipping, cancellation, refunds, per-customer history (no accounts) |
| Coupons | Milestones, admin generation, single use, atomic redemption | Expiry, minimum spend, per-customer limits |
| Pricing | Subtotal, discount, total in cents | Taxes, shipping |
| Payment | Async fake with declines and a charge log | Real provider, timeouts, webhooks, reconciliation |
| Admin | Report, coupons, order history, catalog edits | Authentication and authorisation |
| Storage | In-memory, one instance, idempotency keys expire after 24 h | Database, persistence across restarts |
| Frontend | Small React UI: shop, cart, coupon checkout, order history, admin report; single-click checkout that retries network failures with the same key | Not a focus, per the brief |

## 8. Multiple instances and production scale

In-memory state and locks only work inside one process. With several instances:

| Today (one process) | Production |
|---|---|
| `Store` Maps | PostgreSQL as the single source of truth |
| Product lock + stock check | `UPDATE products SET inventory = inventory - $q WHERE id = $id AND inventory >= $q`; 0 rows updated means out of stock |
| Coupon lock + status check | `UPDATE coupons SET status = 'REDEEMED' WHERE code = $c AND status = 'AVAILABLE'` |
| Cart lock | `SELECT … FOR UPDATE` on the cart row |
| Idempotency Map | Table with `UNIQUE(key)`, insert-first to claim, TTL cleanup |
| In-code uniqueness | `UNIQUE(orders.cart_id)`, `UNIQUE(coupons.milestone)`: the database rejects duplicates even if code is wrong |
| Payment inside the locked section | Two transactions: (1) reserve stock and claim the coupon; (2) after the provider answers, confirm, or release in a compensating transaction. Never hold database locks during a network call. |
| Lost callbacks | Outbox table plus a reconciliation job; webhooks deduplicated by provider event id |
| Report computed on read | Materialised summary or read replica as order volume grows |

Order of work: database and unique constraints first, then conditional updates, then the two-phase payment, then reconciliation. A Redis distributed lock is usually unnecessary once the conditional updates and constraints exist.

## 9. How I used AI tools

I used Claude (Claude Code) as a pair programmer for scaffolding, tests, diagrams and documentation. I set the scope, reviewed the output, and verified behaviour by running it.

| Where AI helped | How I checked it |
|---|---|
| Service and test scaffolding | Ran the tests, then disabled the locks to confirm the race tests fail without them |
| Edge-case discovery | Probed the running server with unusual requests (oversized body, malformed URL, duplicate headers) |
| Docs and diagrams | Compared every error code and claim against the code |

**Where I redirected or corrected the AI:**

1. **Scope.** The first architecture proposals added AWS infrastructure (load balancer, WAF, NAT, Multi-AZ), then a SQLite and PostgreSQL layer. I rejected that: the brief allows an in-memory store and rewards reasoning over infrastructure. I redirected to a single process with explicit locks and moved the database discussion to Section 8.
2. **Tests that did not test what they claimed.** Three generated tests meant to send a request "mid-checkout" created the Supertest request without sending it; Supertest sends only when awaited. They passed by luck. A failing price-change test (X11) exposed it, and the requests are now started explicitly.
3. **A deadlock test that could not deadlock.** The first X5 passed even with lock sorting removed, so it proved nothing. I had it rebuilt with a third shopper holding a product, which reproduces the deadlock when sorting is removed.
4. **Documentation drift.** A generated sequence diagram used error codes that did not exist in the API (`OUT_OF_STOCK`, `PAYMENT_FAILED`). I caught it by comparing it with `domain/errors.ts`.
5. **Bugs found by probing, not by generated tests.** A body over 16 KB and a malformed URL both returned 500. Both are fixed (413 and 400) and covered by P5 and P8.
6. **A load test that reported a false failure.** The first version of `load-test.ts` reset a product's stock to a value read at the start of the run, which broke its own stock-conservation check mid-run. I traced the mismatch to the script (the server's order, revenue and coupon numbers all matched) before touching the service, and fixed the script to account for any stock it adds.

## 10. With two more hours

| Priority | What | Why |
|---|---|---|
| 1 | Reserve stock and the coupon in a synchronous block, pay outside the product locks, confirm or restore (exactly once) | Lifts the measured limit: throughput per hot product is about 1 / payment latency. Changes what shoppers see while a payment is in flight (test X9) |
| 2 | Public `GET /rewards/progress`; stop the customer page reading `/admin/report` | Keeps the customer / admin boundary clean |
| 3 | Persist to SQLite behind the same service interface | Survives restarts; a step toward Section 8 |
| 4 | Reconcile `PAYMENT_TIMEOUT` outcomes (outbox plus a status check at the provider) | After a 504 the real charge state is unknown with a real provider |
| 5 | Authentication, and per-customer coupon and order history | Admin routes are public; coupons are store-wide |

---

**Time spent:** _fill in the approximate hours here before submitting._
