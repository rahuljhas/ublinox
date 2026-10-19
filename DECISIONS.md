# DECISIONS

Checkout & Rewards Service: Node.js + TypeScript + Express, in-memory store, one instance. Live: https://ublinox.vercel.app (store) and https://ublinox-api.onrender.com (API).

Code references are relative to `backend/src/`. Test IDs (K12, X3, E1, T4, CU5 …) are explained in `docs/TEST_PLAN.md` and `docs/EDGE_CASES.md`. The full error catalogue is `docs/ERRORS.md`.

## How this document maps to the brief

| The brief asks for | Section |
|---|---|
| System invariants | [1](#1-system-invariants) |
| Ambiguities and the semantics chosen; money and rounding rules | [2](#2-requirements-and-business-rules) |
| At least five material decisions with alternatives | [3](#3-material-design-decisions) (14 decisions) |
| Transaction, concurrency and idempotency strategy | [4](#4-transaction-concurrency-and-idempotency-strategy), [5 Locks](#5-locks), [7 Retries](#7-retries-and-idempotency) |
| Error-model choices | [8](#8-error-model-and-descriptions), with input checks in [6](#6-input-validation) |
| Edge cases | [9](#9-edge-cases) |
| Tracking several shoppers at once (user switching) | [10](#10-multiple-customers-switching-users-to-test-concurrency) |
| Testing details | [11](#11-testing) |
| Implemented versus deferred | [12](#12-implemented-vs-deferred) |
| Multiple instances and production scale | [13](#13-multiple-instances-and-production-scale) |
| How AI tools were used, including corrections | [14](#14-how-i-used-ai-tools) |
| What to examine in two more hours | [15](#15-with-two-more-hours) |

---

## 1. System invariants

| ID | Invariant | Enforced in | Proved by |
|---|---|---|---|
| I1 | Stock never goes below zero; sold + remaining = starting stock | `services/checkoutService.ts` (check under product lock) | X3, S1, L1 |
| I2 | A cart becomes at most one order | cart lock + `status !== "OPEN"` check | K6, K17 |
| I3 | One Idempotency-Key produces at most one order | idempotency check before the first `await` | K12, K13, L3 |
| I4 | A coupon is redeemed at most once, and only by a checkout that commits | coupon lock + status check + commit block | K18, K11 |
| I5 | A failed checkout changes nothing | all writes happen in the commit block, after every check and the payment | K11, X6, E4, T4 |
| I6 | Coupons generated ≤ floor(placed orders / n); one coupon per milestone | `services/couponService.ts` | M1–M5 |
| I7 | Money is integer cents; 0 ≤ total ≤ subtotal | `domain/money.ts` | K19, K20, E6 |
| I8 | An order keeps the prices it charged | `OrderLine` snapshot | O3 |
| I9 | The report equals the stored orders and coupons, and reading it changes nothing | `services/reportService.ts` | R2, R4, H6 |
| I10 | An order belongs to the customer who owned its cart; a customer's history lists only their orders | `customerId` copied at commit; filter in `listCustomerOrders` | CU3, CU5 |

## 2. Requirements and business rules

### 2.1 Ambiguities and chosen semantics

| Question the brief left open | Chosen semantics |
|---|---|
| Price changes after an item is added | The cart always shows current prices. The order charges the price at checkout. If the client sends `expectedSubtotalCents` and it differs, checkout returns `409 PRICE_CHANGED` and charges nothing. |
| Stock changes after an item is added | Adding to a cart does not reserve stock. Checkout re-checks stock and returns `409 INSUFFICIENT_INVENTORY` with requested and available per line. |
| What counts toward the n-th order | Successful orders only, one per checkout regardless of quantity. Orders that used a coupon still count. Failed and replayed checkouts do not. |
| When a coupon is created | When an admin calls `POST /admin/coupons`; one call creates the coupon for the earliest unrewarded milestone. |
| Who can use a coupon | Anyone holding the code, once. No expiry, no minimum spend. The percentage is fixed when the coupon is generated. |
| What the discount applies to | The whole order subtotal, rounded half up to the cent, capped at the subtotal. |
| Order statuses | An order exists only after payment is approved and the commit succeeds, so its status is `CONFIRMED`. The cart moves `OPEN → CHECKED_OUT` once. |
| Same Idempotency-Key, different body | Rejected with `422 IDEMPOTENCY_KEY_REUSED`. "Same request" means same cart and same coupon. |
| Retry after a failed checkout | The key is released, so the same key is evaluated again (useful after fixing the cart). |
| Payment | A fake asynchronous gateway; see the Payment decision. |
| Admin authentication | Not implemented. Admin operations are those under `/admin/*`. |
| Who is a "customer" | A demo identity: the client declares a `customerId` when it creates a cart (three in the UI: `u-aisha`, `u-ben`, `u-chloe`). Orders copy it from the cart. There is no login, so this separates carts and history for testing but is not access control. |

### 2.2 Pricing, rounding and discount

All money is **integer cents** (`priceCents`, `subtotalCents`, `discountCents`, `totalCents`). The only rounding in the system is the discount, done once, in `domain/money.ts`.

| Step | Rule | Example: 2 × Desk Lamp at $49.99 with a 10% coupon |
|---|---|---|
| Line total | `unitPriceCents × quantity`, at prices current at checkout | 4999 × 2 = 9998 |
| Subtotal | Sum of line totals | 9998 |
| Discount | `floor((subtotal × percent + 50) / 100)`: percent of the subtotal, rounded half up | floor((99 980 + 50) / 100) = 1000 |
| Cap | `discount = min(discount, subtotal)` | 1000 |
| Total | `subtotal − discount`, never negative | 8998 → **$89.98** |
| Amount charged | The total | 8998 |
| Report | Gross = Σ subtotals; discounts = Σ discounts; net = gross − discounts = Σ totals charged | – |

| Subtotal | Exact 10% | Discount (half up) | Total | Note |
|---|---|---|---|---|
| $10.05 (1005¢) | 100.5¢ | 101¢ | $9.04 | exactly half rounds **up** |
| $10.04 (1004¢) | 100.4¢ | 100¢ | $9.04 | below half rounds down |
| $10.06 (1006¢) | 100.6¢ | 101¢ | $9.05 | above half rounds up |
| $0.05 (5¢) | 0.5¢ | 1¢ | $0.04 | smallest case |
| $75.00 at 100% | 7500¢ | 7500¢ | **$0.00** | capped; never negative |

**Why this way:** integer arithmetic is exact (floats give `0.1 + 0.2 = 0.30000000000000004`), half-up is the usual retail rule and is deterministic, and one rounding point means one rule to explain and test (tests: money tests, K19, K20).

### 2.3 Coupon rules

| Rule | Detail |
|---|---|
| Configuration | `COUPON_EVERY_N_ORDERS` (n, default 5) and `COUPON_PERCENT_OFF` (x, default 10), validated at startup |
| Milestone | Milestones reached = `floor(placedOrders / n)`; coupons owed = reached − generated |
| Generation | Admin `POST /admin/coupons` creates `SAVE{x}-XXXXXX` for the earliest owed milestone, or `409 NO_ELIGIBLE_MILESTONE` with `nextMilestoneAtOrder` |
| Use | Customer sends `couponCode` at checkout (case and spaces ignored). Applies to the whole order. |
| Single use | `AVAILABLE → REDEEMED` in the commit block; a second order gets `409 COUPON_ALREADY_REDEEMED` |
| Failure | A checkout that fails for any reason leaves the coupon `AVAILABLE` |
| Counting | Only committed orders count, including orders that used a coupon; five items in one order is one order |

| Orders placed (n = 5) | Milestones reached | Coupons generated | Admin can generate? |
|---|---|---|---|
| 4 | 0 | 0 | No, next milestone at order 5 |
| 5 | 1 | 0 | **Yes** |
| 5 | 1 | 1 | No, milestone 1 already rewarded |
| 12 | 2 | 1 | **Yes**, milestone 2 |

The 5th order itself pays full price. The coupon unlocks afterwards and works on any later order.

### 2.4 Cart and order status

| Object | Statuses | Transition |
|---|---|---|
| Cart | `OPEN` → `CHECKED_OUT` | Once, only when checkout commits. A checked-out cart cannot be edited (409). |
| Order | `CONFIRMED` | Created only after payment is approved and the commit succeeds, so it never exists half-done. Shipping, cancellation and refunds are out of scope. |
| Coupon | `AVAILABLE` → `REDEEMED` | In the commit block of the order that uses it |

### 2.5 Changing a rule: where and what to re-run

| Change | Where | Tests that will tell you |
|---|---|---|
| Different n or x | Environment variables, restart | M tests (they use n = 2) |
| Round differently (down, half-even) | `percentOfCents` in `domain/money.ts` | money tests, K19 |
| Coupon expiry or minimum spend | Add the field in `generateCoupon`, check it beside the "already redeemed" check in checkout, add an error | add a test beside K8 |
| Only orders above some value count toward milestones | The `placedOrders += 1` line in the commit block | M6, M7 |
| One coupon per customer | Store the customer on the coupon; compare with the cart's customer in checkout | add to CU tests |
| Reserve stock before paying | The structure of `checkoutService.ts` (Section 15) | X9, E4, X11 will change on purpose |

## 3. Material design decisions

### Locks

#### Decision: In-process keyed mutex for cart, product and coupon

**Context:** Node runs one piece of JavaScript at a time, so code without `await` cannot interleave. Checkout must `await` the payment provider. During that wait another request runs: two checkouts can both see "1 in stock", both pay, and both commit.

**Options considered:**
1. One global lock around every checkout.
2. No locks; decrement at commit and fail if stock would go negative.
3. Optimistic concurrency: version numbers, retry on conflict.
4. A lock per resource (cart, product, coupon).

**Choice:** Option 4. `domain/keyedMutex.ts` keeps a FIFO promise queue per key (`cart:<id>`, `product:<id>`, `coupon:<code>`). Checkout holds the locks for its cart, products and coupon from validation until commit. Cart edits take the cart lock; admin price or stock changes take the product lock. Details in Section 5.

**Why:** Option 1 is correct but makes a mug purchase wait for an unrelated lamp purchase. Option 2 discovers the conflict after payment, so the loser needs a refund. Option 3 suits a database, but in memory it adds retry loops for no gain and gives no fairness. Per-key locks serialise only requests that touch the same thing, and serve them in arrival order.

**Consequences:** Unrelated checkouts run in parallel. A slow payment holds its product's lock, so shoppers queue behind it; waiting is bounded by the lock-wait timeout (see Backpressure and timeouts). Locks live in process memory, so this only works with one instance (see Persistence).

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

**Consequences:** The outcome of every retry situation is in Section 7. Completed keys expire after 24 h (see Backpressure and timeouts). Tests: K12–K15, K23, E2, X8.

### Backpressure and timeouts

#### Decision: Bound every wait: lock-wait timeout, payment timeout, key expiry

**Context:** A load test (`scripts/load-test.ts`: 100 shoppers, 150 ms simulated payment) passed every invariant but showed checkout p95 latency of 6 s and about 8 orders/s. The cause is the decision "Validate under the locks, then pay": a checkout holds its products' locks while it awaits payment, so shoppers for the same product are served one at a time. Throughput per product is about 1 / payment latency; with a real provider near 1 s that is about one order per second per hot product. Three risks followed: the queue behind a slow checkout has no limit, a provider that never answers would hold a product's lock forever, and completed idempotency keys were never freed.

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

**Consequences:** Under a burst some shoppers get 503 and must retry. Throughput per hot product is still capped by payment latency; Option 2 is the fix when that matters (Section 15). A 504 leaves the real outcome unknown with a real provider, so reconciliation (outbox plus a status check) is deferred (Section 12). The mutex hands an abandoned place in line on to the next waiter; without that, one timed-out request would block the product forever (test T2). Tests: T1–T8, L1–L3.

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

**Choice:** All amounts are integer cents. The only rounding is the discount, computed as `floor((subtotal × percent + 50) / 100)`, capped at the subtotal. Rules and examples are in Section 2.2.

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

**Consequences:** A restart or redeploy wipes all data: orders, carts, coupons and idempotency keys. A retry after a restart therefore gets `404 CART_NOT_FOUND`, not a duplicate order. Two instances would each have their own stock and locks and could oversell. Section 13 covers the move to a database.

### Payment

#### Decision: Fake asynchronous payment gateway

**Context:** No real payment integration is required, but the design must survive payment being slow or failing.

**Options considered:** treat checkout as payment success (no step at all); a synchronous stub; an asynchronous fake behind an interface.

**Choice:** `domain/payment.ts` defines `PaymentGateway` with a `FakePaymentGateway` that waits `PAYMENT_DELAY_MS` (default 150 ms), records every charge, and can be told to decline (`declineNext`) or never answer (`hangNext`).

**Why:** With no payment step there is no `await` in checkout, which hides the race the brief asks about. The asynchronous fake recreates the real window in which other requests run, and makes declines, timeouts and "who was charged" testable (X9, E4, T4).

**Consequences:** A real provider can replace the fake behind the same interface. Webhooks, duplicate callbacks, reconciliation and refunds are not modelled (deferred).

### API

#### Decision: Demo customers are a client-declared id, with their own cart and history

**Context:** Testing "many customers, one product" and showing per-customer order history needs more than one shopper, but the brief says authentication need not be implemented.

**Options considered:**
1. One anonymous shopper per browser; history from ids saved in `localStorage`.
2. Real accounts with login.
3. A declared `customerId` on the cart, copied to the order, with three demo customers selectable in the UI.

**Choice:** Option 3. `POST /carts` takes an optional `customerId` (lower-case letters, digits, dashes, up to 40). The order copies it from the cart. `GET /orders?customerId=` returns that customer's orders with their lines, newest first; the id is required so the endpoint is not a way to list every order. The admin order list shows the customer. The UI keeps one open cart per customer and ignores a slow response that finishes after the user has switched. Section 10 shows the results.

**Why:** Option 1 ties history to one browser and cannot show two shoppers competing. Option 2 is a large feature the brief does not ask for. Option 3 is a few lines in the service, keeps history on the server, and makes the main scenarios (two shoppers, one last unit; per-customer history) easy to test by hand and by script.

**Consequences:** Nothing proves who a customer is, so anyone can read another customer's history by guessing the id. That is acceptable for a demo and is listed in the production steps (Section 15). Carts and orders created without a customer (the load tests, API clients) have `customerId: null` and still work. Tests: CU1–CU8.

#### Decision: PUT sets the item quantity (no "add 1" endpoint)

**Context:** Customers double-click "Add", and clients retry requests.

**Options considered:** `POST /items` that increments; `PUT /items/{productId}` with an absolute quantity.

**Choice:** `PUT /carts/{id}/items/{productId}` with `{ quantity: 1-99 }`, which adds the line or replaces its quantity. `DELETE` removes it.

**Why:** A retried "add one" adds twice; a retried "set to 2" is harmless. To keep deliberate rapid clicks from being lost, the UI disables "Add" until the previous update returns.

**Consequences:** Cart edits are idempotent (X12, E3). The client must know the current quantity, which it always has from the last cart response.

#### Decision: One error envelope with stable codes

**Context:** Errors must be distinguishable and useful to an API client.

**Options considered:** HTTP status plus a free-text message; RFC 7807 problem details; a custom envelope with a stable code.

**Choice:** Every error is `{ error: { code, message, details } }` with 24 codes (`domain/errors.ts`). See Section 8.

**Why:** Clients branch on a stable `code`; `details` carries what they need to act, such as `available` per line or the existing `orderId`. It is simpler than RFC 7807 and carries the same information.

**Consequences:** Adding a failure means adding a code and documenting it in `docs/ERRORS.md`. Client mistakes never surface as 500 (fixed: oversized body → 413, malformed URL → 400).

---

## 4. Transaction, concurrency and idempotency strategy

How the decisions above combine on `POST /carts/{id}/checkout`:

| Step | Action | Decision |
|---|---|---|
| 1 | Validate header and body | Input validation (Section 6) |
| 2 | Claim the Idempotency-Key synchronously (replay, 409 or 422 if already used) | Idempotency |
| 3 | Lock the cart; check it is open and not empty | Locks, lock order |
| 4 | Lock the coupon and products (sorted); check stock, coupon, price assertion | Locks, inventory and pricing |
| 5 | `await` payment, giving up after `PAYMENT_TIMEOUT_MS` | Payment, backpressure |
| 6 | Commit every write in one block with no `await`; store the response under the key | Checkout flow |
| 7 | `finally`: release locks. On error the key is deleted and nothing was written | Checkout flow, idempotency |

Which operation takes which lock is in Section 5; what a client does after each outcome is in Section 7.

## 5. Locks

### Why locks exist in single-threaded Node

The payment `await` is the one moment other requests run while a checkout is half done. Two shoppers, one last print:

| Time | Shopper A | Shopper B |
|---|---|---|
| 1 | Takes `product:p-print` | Asks for it and waits in line |
| 2 | Checks stock (1) → OK | – |
| 3 | `await payment` (150 ms) | Still waiting |
| 4 | Commit: stock 1 → 0, order saved | – |
| 5 | Releases the lock | Gets the lock |
| 6 | – | Checks stock: **0** → `409 INSUFFICIENT_INVENTORY`, never charged |

Without the lock both would pass step 2 and the stock would end at −1.

### Which operation takes which lock

| Operation | Locks taken | What it protects |
|---|---|---|
| Checkout | `cart:<id>` first, alone; then `coupon:<CODE>` and every `product:<id>` in the cart, sorted, in one call | Nothing it validated can change before it commits |
| Add, change or remove a cart item | `cart:<id>` | A cart cannot change while it is being paid for (K21) |
| Admin price or stock edit | `product:<id>` | Stock or price cannot change mid-checkout (K24, X11) |
| Generate coupon | none: no `await`, so it cannot interleave | One coupon per milestone (M5) |
| Reports, order lists, cart view, product list | none: read-only and synchronous | They never see a half-finished order |

### How the mutex behaves (`domain/keyedMutex.ts`)

| Property | How | Test |
|---|---|---|
| Mutual exclusion | One promise queue per key; a request runs only after the one ahead of it releases | X3, K16, K18 |
| Fairness | First in, first out per key | by construction (a promise chain per key); not asserted by a test |
| No deadlock | `acquire(keys)` de-duplicates and sorts the keys; the cart is taken first on its own | X5 |
| Bounded wait | After `LOCK_WAIT_MS` (10 s) the request gets `503 SERVER_BUSY` with `Retry-After: 2` | T1, L2 |
| No stuck queue | A request that gave up still hands its place on when its turn arrives | T2 |
| No partial locks | If a multi-key acquire times out, the keys it already took are released | T3b |
| No leak | Locks are released in `finally`, on success and on every error; a second release is ignored | T5, X8 |

### Limits

| Limit | Effect | Path forward |
|---|---|---|
| Locks live in one process | Two instances would not see each other's locks | Database conditional updates and row locks (Section 13) |
| Locks are held across the payment call | A hot product serves about 1 / payment latency orders per second; measured 8 orders/s overall at 150 ms | Reserve, pay outside the lock, confirm (Section 15) |
| FIFO per product, not per customer | A heavy buyer can wait behind many others | Rate limiting, queue visibility (deferred) |

## 6. Input validation

Every request passes three gates before any business rule runs. Each fails with a 4xx and writes nothing.

| Gate | Where | Checks | Failure |
|---|---|---|---|
| 1. Parse | `express.json({ limit: "16kb" })` | Body is valid JSON and under 16 KB | `400 INVALID_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE` |
| 2. Shape | zod schemas in `http/app.ts`, applied by `parse()` | Types, ranges, unknown fields | `400 VALIDATION_ERROR` |
| 3. Header | `idempotencyKey` schema | Checkout key: 8–100 characters, only `A-Z a-z 0-9 . _ : -` | `400 IDEMPOTENCY_KEY_REQUIRED` |

| Input | Rule |
|---|---|
| Item quantity | whole number, 1–99; nothing else in the body |
| `couponCode` | text, 1–40 characters after trimming; case and surrounding spaces ignored |
| `expectedSubtotalCents` | whole number ≥ 0, optional |
| Admin `priceCents` / `inventory` | whole numbers, 0–100 000 000 / 0–1 000 000; at least one present |
| `limit`, `offset` | 1–100 (default 20), ≥ 0 (default 0) |
| `customerId` | lower-case letters, digits, dashes, 1–40; required to list a customer's orders |
| Path ids (cart, product, order, coupon) | not pattern-checked; an unknown id gives 404 |
| Server configuration | `COUPON_*`, `LOCK_WAIT_MS`, `PAYMENT_TIMEOUT_MS`, `IDEMPOTENCY_TTL_MS` must be positive integers or the server refuses to start (T8) |

How it behaves:

- Every schema is `.strict()`: an unknown field is a loud 400, not silently ignored. A typo such as `qty` cannot pass.
- `parse()` collects every failing field into `details.issues: [{ path, message }]`, so a form can highlight all of them.
- A body sent with the wrong content type counts as empty (so a required field is "missing"); a JSON array gives `VALIDATION_ERROR`; a bare `null` or number gives `INVALID_JSON`.
- Input validation asks "is this request well-formed?" (400). State validation asks "is this allowed right now?" (stock, cart status, coupon) and runs under the locks (409 or 422). They are separate on purpose.
- The browser limits quantities too, but only as convenience. The server never trusts it.

Probing the running server found two real gaps: a body over 16 KB and a malformed URL both returned 500. Both are fixed (413 and 400). Tests: P3, P5–P8, A5, A6, A11, K2, K10, K22, K23, U2, U3, H5, CU2, CU4, E10, T8.

## 7. Retries and idempotency

### Who retries

| Actor | When | What it does |
|---|---|---|
| The browser, automatically | A network error, `REQUEST_IN_PROGRESS` or `SERVER_BUSY` | Up to 2 retries after 0.8 s and 1.6 s, always with the **same** Idempotency-Key. Any other error is shown to the customer. |
| The customer | After fixing a cart, or after a decline | Checks out again; the same key is fine because failures free it |
| An API client | Any timeout | Resends the same request with the same key |

The UI also ignores clicks while a checkout is running, so a double-click sends one request.

### Key lifecycle

| State | Entered when | Leaves when |
|---|---|---|
| (none) | – | A checkout request arrives |
| `IN_PROGRESS` | Claimed synchronously, before the first `await`, with a fingerprint of cart id and coupon | The checkout finishes |
| `COMPLETED` | Commit succeeded; the 201 response is stored | Swept after `IDEMPOTENCY_TTL_MS` (24 h) |
| (deleted) | Any failure before the commit | – |

### What each retry situation returns

| Situation | Response | Safe because | Tests |
|---|---|---|---|
| Response lost, same key resent | The stored 201 with `Idempotent-Replayed: true` | Nothing runs again | K12, E2 |
| Same key sent while the first is running | `409 REQUEST_IN_PROGRESS`; the browser waits and retries | The key is claimed; only one request proceeds | K13, L3 |
| New key for a cart that already became an order | `409 CART_ALREADY_CHECKED_OUT` with the existing `orderId` | A cart can become one order | K17, E2 |
| Same key for a different cart or coupon | `422 IDEMPOTENCY_KEY_REUSED` | The fingerprint differs | K14 |
| Out of stock, coupon used, price changed | 409; fix the cart and resend with the same key | The failure freed the key and wrote nothing | X7, X8, E7 |
| Payment declined (402) | Resend with the same key | Nothing was written | K11, X9 |
| `503 SERVER_BUSY` | Wait `Retry-After`, resend with the same key | Never reached payment; key freed | T1–T3, L2 |
| `504 PAYMENT_TIMEOUT` | Not retried automatically; check whether the provider charged | Nothing recorded here; the key is forwarded to the provider so a real provider can dedupe | T4, T5 |
| Key older than 24 h | `409 CART_ALREADY_CHECKED_OUT` | The cart check still prevents a second order | T6 |
| Server restarted | `404 CART_NOT_FOUND` | Carts are gone too | – |
| Cart edit resent | Same cart state | `PUT` sets the quantity instead of adding | X12, E3 |

Not idempotent by design: `POST /admin/coupons`. Each call creates the next owed coupon, so repeating it after a lost response can create a second one if another milestone is owed (concurrent calls are safe, M5). Deferred.

## 8. Error model and descriptions

Every error has the same shape and clients branch on `code`:

```json
{ "error": { "code": "INSUFFICIENT_INVENTORY", "message": "Not enough stock for one or more items.",
             "details": { "lines": [{ "productId": "p-print", "requested": 4, "available": 3 }] } } }
```

| Status | Used for |
|---|---|
| 400 | Malformed or invalid request |
| 402 | Payment declined |
| 404 | Missing cart, product, order, coupon, line or route |
| 409 | Valid request that conflicts with current state |
| 413 / 415 | Body too large / unsupported body type |
| 422 | Well-formed but meaningless |
| 500 | Unexpected server errors only |
| 503 | Server busy: waited too long for a lock; sends `Retry-After: 2` |
| 504 | The payment provider did not answer in time |

| Code | HTTP | Meaning | `details` |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | A field is missing, the wrong type, out of range or unknown | `issues[]` |
| `INVALID_JSON` | 400 | The body is not valid JSON, or is `null` | – |
| `BAD_REQUEST` | 400 | Malformed URL encoding | – |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Checkout without a valid key | – |
| `PAYMENT_DECLINED` | 402 | The provider declined; nothing charged or reserved | `reason` |
| `CART_NOT_FOUND` | 404 | No such cart | `cartId` |
| `PRODUCT_NOT_FOUND` | 404 | No such product | `productId` |
| `ITEM_NOT_IN_CART` | 404 | Removing a product that is not in the cart | `productId` |
| `ORDER_NOT_FOUND` | 404 | No such order | `orderId` |
| `COUPON_NOT_FOUND` | 404 | No such coupon code | `code` |
| `ROUTE_NOT_FOUND` | 404 | Unknown path or method | – |
| `INSUFFICIENT_INVENTORY` | 409 | More requested than in stock | `lines[]` with requested and available |
| `CART_ALREADY_CHECKED_OUT` | 409 | The cart is already an order | `cartId`, `orderId` |
| `COUPON_ALREADY_REDEEMED` | 409 | Another order used the coupon | `code` |
| `PRICE_CHANGED` | 409 | The subtotal the client showed differs from the current one | old and new subtotal, lines |
| `REQUEST_IN_PROGRESS` | 409 | The same key is still being processed | – |
| `NO_ELIGIBLE_MILESTONE` | 409 | No unrewarded milestone has been reached | `placedOrders`, `nextMilestoneAtOrder` |
| `PAYLOAD_TOO_LARGE` | 413 | Body over 16 KB | – |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The body type cannot be parsed | – |
| `CART_EMPTY` | 422 | Checkout with no items | `cartId` |
| `IDEMPOTENCY_KEY_REUSED` | 422 | The key belongs to a different request | – |
| `SERVER_BUSY` | 503 | Waited longer than `LOCK_WAIT_MS` for a lock | `resource` |
| `PAYMENT_TIMEOUT` | 504 | No answer within `PAYMENT_TIMEOUT_MS`; nothing recorded | – |
| `INTERNAL_ERROR` | 500 | Unexpected error (logged) | – |

Rules behind the model:

- A client mistake never returns 500; 5xx means a server problem or an overloaded server.
- A failed request writes nothing. Checkout returns the **first** failing check in a fixed order (the 12 steps are in `docs/ERRORS.md`).
- `message` is for people and may change; `code` and `details` are the contract.
- In the browser every error appears as a toast `CODE: message`. `PRICE_CHANGED` is handled specially: the cart reloads and the customer is asked to confirm; `SERVER_BUSY` and `REQUEST_IN_PROGRESS` are retried quietly.

## 9. Edge cases

Each row has a test. The full walkthrough of the assignment's list is `docs/EDGE_CASES.md`.

| Group | Case | Behaviour | Tests |
|---|---|---|---|
| Duplicates | Customer double-clicks "Place order" | One order, one charge; the second request gets 409 | E2, K13, L3 |
| | A new key per click for the same cart | `409 CART_ALREADY_CHECKED_OUT` with the order id | E2, K17 |
| | Response lost after success | Retry returns the same order | K12 |
| Stock races | Two orders for the last unit | First `CONFIRMED`; second 409, not charged, cart stays open | E1, K16 |
| | 50 shoppers, 3 units | Exactly 3 orders | X3 |
| | 3 in stock; one buys 1, then another asks for 3 | Told exactly 2 are left; can then buy 2 | E5, X4 |
| | Several people race for the last unit | Only the winner is charged, so no refunds are needed | E4 |
| | One item in a multi-item cart sells out | Whole checkout refused; other items untouched | X6 |
| | The winner's payment is declined | The next shopper gets the unit | X9 |
| | Two carts list the same products in opposite order | No deadlock | X5 |
| | Stock and amounts | Never negative | E6, S1 |
| Cart | "Add" clicked 3 times | Each deliberate click counts; a duplicated request does not | E3, X12 |
| | Cart edited during its own checkout | Waits, then 409 `CART_ALREADY_CHECKED_OUT` | K21 |
| | Last item removed, then checkout | 422 `CART_EMPTY` | D5 |
| Pricing | Admin changes a price while the page is open | 409 `PRICE_CHANGED`; cart reloads with the new price | E7, E9 |
| | Price change during a payment | Waits; the in-flight order pays the price it validated | X11 |
| | Client omits `expectedSubtotalCents` | Charged the current price | E8 |
| Coupons | Same coupon, two carts at once | One wins; the other 409 | K18, X13 |
| | Failed checkout | The coupon stays available | K11 |
| | Admin generates twice, or concurrently | One coupon per milestone | M3, M5 |
| | Lower-case code with spaces | Accepted | K9 |
| | 100% coupon; half-cent rounding | Total $0.00; half rounds up | K19, K20 |
| Failures | Payment declined | 402; nothing written | K11 |
| | Payment never answers | 504 after 15 s; locks and key released | T4, T5 |
| | Slow checkout, long line | 503 after 10 s; never charged; retry works | T1–T3, L2 |
| Input | Oversized body, bad URL, non-object JSON, wrong content type, bad quantities | 4xx with a specific code, never 500 | P5–P8, A5, A11 |
| Customers | Two customers hold the last unit | One order; the other refused; histories correct | CU5 |
| | One customer's order | Other customers' carts and history unchanged | CU6 |
| Server | Restart | All in-memory data is lost (documented limit) | – |

## 10. Multiple customers: switching users to test concurrency

**The problem.** The app started with a single anonymous shopper per browser. One person could not make two shoppers compete from the UI, so concurrency only showed up in scripts and tests, and order history could not be told apart per customer.

**The answer.** Three demo customers, chosen from a switcher in the header ("Shopping as …"):

| Customer | Id |
|---|---|
| Aisha Khan | `u-aisha` |
| Ben Carter | `u-ben` |
| Chloe Martin | `u-chloe` |

How it works (decision in Section 3, "Demo customers"):

- `POST /carts` declares the `customerId`; the order copies it from the cart; `GET /orders?customerId=` returns that customer's history; the admin order list shows who ordered.
- The browser keeps **one open cart per customer** and remembers the selected customer across reloads.
- A response that arrives after the user has switched is ignored, so one customer's slow checkout cannot overwrite another customer's screen.
- This is not authentication: nothing proves who a customer is.

**Results.** Checked by driving a real Chrome browser against the app, locally and on the deployed site, and reading the results from the page:

| # | Scenario | Result |
|---|---|---|
| S1 | Aisha and Ben both put the last art print in their carts; Ben checks out first, then Aisha | Ben gets an order ($75.00). Aisha's cart shows "only 0 left"; her checkout is refused with `INSUFFICIENT_INVENTORY`, no receipt appears and her cart is intact. Ben's history shows 1 order, Aisha's none. |
| S2 | Switch from Aisha (1 item) to Ben | Ben's cart is empty (badge 0); Aisha's still holds her item when switching back |
| S3 | Reload the page | The selected customer and their cart are restored |
| S4 | Open the Admin order table | The order shows the customer name ("Ben Carter") |
| S5 | Chloe starts a checkout (150 ms payment) and the user switches to Ben immediately | Chloe's order is still recorded (1 order for Chloe); the screen stays on Ben with an empty cart and no receipt |
| S6 | Deployed site (Vercel + Render): switch to Chloe, then Ben | Chloe's API-placed order appears in her history; adding to Chloe's cart does not touch Ben's |

**Automated equivalents:** CU1–CU8 (customer tagging, per-customer history, two customers racing, separate carts), E1 and E4 (last-unit races), and the load tests L1–L3.

**To reproduce in two minutes:** set the art print's stock to 1 (Admin → Catalog), add it to Aisha's cart, switch to Ben and add it, check out as Ben, switch back to Aisha and check out.

## 11. Testing

### Layers

| Layer | What | Size | Run |
|---|---|---|---|
| Automated, in process | Each test starts its own real HTTP server on a random port with fresh data and a fake payment that waits, so concurrent requests genuinely overlap | 140 tests | `cd backend && npm test` |
| Live black-box checks | Public HTTP only, against any running server | 37 checks | `npm run edge-cases` |
| Load test | Hot-product race, mixed shoppers with admin price edits, double-clicks, coupon race; then checks stock conservation, order counts, revenue, coupons and status codes | 4 phases | `USERS=100 npm run load` |
| Real-browser checks | Chrome driven by script: switching customers, the last-unit scenario, a switch during a checkout, the deployed site | Section 10 | manual |

### Automated tests by file

| File | Tests | Protects |
|---|---|---|
| `endpoints.test.ts` | 54 | Every endpoint against every bad input, state conflict and malformed request |
| `customers.test.ts` | 16 | Customer tagging, per-customer history, two customers racing, separate carts |
| `contention.test.ts` | 14 | Many shoppers, one product (X1–X14) |
| `edgeCases.test.ts` | 11 | The assignment's edge-case list (E1–E10) |
| `orderHistory.test.ts` | 11 | Admin order list and pagination |
| `hardening.test.ts` | 10 | Lock-wait timeout, payment timeout, key expiry, config checks (T1–T8) |
| `checkout.test.ts` | 9 | Overselling, same-cart races, retries, declines, price snapshots |
| `coupons.test.ts` | 5 | Milestones, coupon races, report reconciliation |
| `money.test.ts` | 4 | Rounding, no float drift, totals never negative |
| `invariants.test.ts` | 3 | 60 random overlapping operations (3 seeds), then every invariant I1–I9 |
| `load.test.ts` | 3 | 120 shoppers at once, queue shedding, 40 double-clickers (L1–L3) |
| **Total** | **140** | |

### Do the tests catch real bugs?

I broke each protection on purpose and ran the tests:

| Break | Tests that fail |
|---|---|
| Locks disabled | X3, X4, X11, X13, X14, K16–K18, K21, S1, L1, L2 |
| Lock sorting removed | X5 (deadlocks and times out) |
| Lock-wait timeout removed | T1 |
| A timed-out waiter does not hand on its place | T2 |
| A failed multi-key acquire keeps its locks | T3b |
| Payment timeout removed | T4 |
| Idempotency key sweep removed | T6 |

Running the full suite repeatedly (6 times in a row) gave no flaky failures.

### Load and live results

| Run | Where | Shoppers | `LOCK_WAIT_MS` | Orders | Checkout p50 / p95 / max | Shed (503) | 5xx | Invariants |
|---|---|---|---|---|---|---|---|---|
| A | laptop | 100 | 10 s | 81 (8.0/s) | 1.2 s / 6.3 s / 6.3 s | 0 | 0 | all pass |
| B | laptop | 250 | 3 s | 63 (8.9/s) | 3.0 s / 3.0 s / 3.3 s | 175 | 0 | all pass |
| C | deployed API (Render free plan) | 60 | 10 s | 67 (4.3/s) | 0.6 s / 4.4 s / 4.8 s | 0 | 0 | all pass |

Latency grows with the number of shoppers per product, because they are served one at a time, and is capped by the lock-wait timeout. The deployed run is slower because the free instance has little CPU and every request crosses the internet.

On the deployed API the 37 live checks give 36 passes on a freshly restarted instance. The one miss (P8, a malformed URL) returns Render's own `520` because its proxy rejects the URL before the app sees it. (An earlier K5 failure came from data left by the load test, not from a bug.)

### What is not covered

| Gap | Why |
|---|---|
| No automated frontend tests | The UI is small and was checked by hand and by browser automation; the brief says the backend matters most |
| Real payment provider | The gateway is a fake; webhooks and reconciliation are not exercised |
| More than one server instance | Not supported by design (Section 13) |
| Sustained load beyond a few minutes | The load test is a burst, not a soak |

## 12. Implemented vs deferred

| Area | Implemented | Deferred, and why |
|---|---|---|
| Catalog | 6 seeded products; admin price and stock edits | Create / deactivate products (not in the brief) |
| Cart | Create, view with live prices and stock warnings, set quantity, remove | Cart expiry |
| Checkout | Idempotent, locked, validate → pay → commit, price-change guard, bounded lock wait (503), payment timeout (504) | Reserve-then-pay to lift the per-product throughput limit (Section 15) |
| Orders | Snapshot lines, `CONFIRMED` status, `GET /orders/{id}`, paginated `GET /admin/orders`, per-customer history for declared demo customers | Shipping, cancellation, refunds |
| Customers | Three demo customers with separate carts and history | Real accounts and login |
| Coupons | Milestones, admin generation, single use, atomic redemption | Expiry, minimum spend, per-customer limits; idempotent generation |
| Pricing | Subtotal, discount, total in cents | Taxes, shipping |
| Payment | Async fake with declines, hangs and a charge log; key forwarded to the provider | Real provider, webhooks, reconciliation after a 504 |
| Admin | Report, coupons, order history, catalog edits | Authentication and authorisation |
| Storage | In-memory, one instance, idempotency keys expire after 24 h | Database, persistence across restarts |
| Frontend | Small React UI: shop, cart, coupon checkout, per-customer order history, customer switcher, admin report | Automated UI tests; not a focus, per the brief |
| Deployment | Render (API, one instance) and Vercel (store) | Automatic deploy on push (neither service gets push events; deploys are manual commands) |

## 13. Multiple instances and production scale

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
| Declared `customerId` | Real accounts and authentication; orders and carts checked against the logged-in customer |
| Report computed on read | Materialised summary or read replica as order volume grows |

Order of work: database and unique constraints first, then conditional updates, then the two-phase payment, then reconciliation. A Redis distributed lock is usually unnecessary once the conditional updates and constraints exist.

## 14. How I used AI tools

I used Claude (Claude Code) as a pair programmer throughout. I set the scope, reviewed what it produced, and verified behaviour by running it. This is how the work went, stage by stage.

### The workflow

| Stage | What the AI did | How I confirmed it | Evidence |
|---|---|---|---|
| Requirements | Read `task.md`, listed the invariants, ambiguities and hidden requirements, and proposed a semantic for each | I reviewed each choice and kept or changed it; `docs/REQUIREMENTS.md` maps every requirement to code and a test, and marks the gaps | Sections 1–2; 25-row checklist |
| Architecture and choices | Drafted options and diagrams (components, layers, checkout sequence) | I rejected the over-built versions (below) and kept a single process with explicit locks; the sequence diagram is checked against the code | Section 3; `docs/checkout-sequence.png` |
| Implementation | Wrote the services, validation, error model and tests | Ran the tests, then disabled each protection to check the tests fail without it | Section 11, "Do the tests catch real bugs?" |
| Edge cases | I supplied the assignment's list; the AI added more by probing the running server with unusual requests | Each case became a test with an ID; probing found two real 500s | Sections 6 and 9; E1–E10 |
| Business logic | Implemented the rounding, discount and milestone rules | Worked examples checked by hand against the formulas; tests for half-cent cases, caps and 100% coupons | Section 2; money tests, K19, K20, M1–M7 |
| End-to-end verification | Wrote the live scripts and the load test | Ran them against the local server and the deployed one; drove a real browser for the customer scenarios | Sections 10 and 11 |
| Documentation | Generated the error catalogue, test plan, edge-case doc and this file | Compared numbers and codes with the code; found and fixed drift | corrections 4 and 8 below |

### Where I redirected or corrected the AI

1. **Scope.** The first architecture proposals added AWS infrastructure (load balancer, WAF, NAT, Multi-AZ database), then a SQLite and PostgreSQL layer. I rejected that: the brief allows an in-memory store and rewards reasoning over infrastructure. I redirected to a single process with explicit locks, removed the AWS diagram from the repository, and moved the database discussion to Section 13.
2. **Tests that did not test what they claimed.** Three generated tests meant to send a request "mid-checkout" created the Supertest request without sending it; Supertest sends only when awaited. They passed by luck. A failing price-change test (X11) exposed it, and the requests are now started explicitly.
3. **A deadlock test that could not deadlock.** The first X5 passed even with lock sorting removed, so it proved nothing. I had it rebuilt with a third shopper holding a product, which reproduces the deadlock when sorting is removed.
4. **Documentation drift.** A generated sequence diagram used error codes that did not exist in the API (`OUT_OF_STOCK`, `PAYMENT_FAILED`). I caught it by comparing it with `domain/errors.ts`.
5. **Bugs found by probing, not by generated tests.** A body over 16 KB and a malformed URL both returned 500. Both are fixed (413 and 400) and covered by P5 and P8.
6. **A load test that reported a false failure.** The first version of `load-test.ts` reset a product's stock to a value read at the start of the run, which broke its own stock-conservation check mid-run. I traced the mismatch to the script (the server's order, revenue and coupon numbers all matched) before touching the service, and fixed the script to account for any stock it adds.
7. **A flaw found by using the UI.** The receipt had a "send the same checkout again" button where the Checkout button had been. One click could show "Replayed", which looked like an error although the server had behaved correctly. I redesigned it: the Checkout button ignores clicks while a request runs, network failures are retried silently with the same key, and the receipt button and the "concurrency demo" were removed.
8. **A wrong claim about deployment.** The README said the API redeploys on every push. After pushing, the deploy list still showed the old commit: a service created from a public repository URL gets no push events. I triggered the deploy by command and corrected the README.
9. **A race in my own user-switching design.** A checkout started by one customer would finish after the user had switched and could draw that customer's new cart over the next customer's screen. I added a guard that drops results for a customer who is no longer selected, then confirmed it in a real browser (scenario S5).

### What I did not hand over

- The trade-offs: pay-then-commit instead of reserving stock, a bounded queue instead of a redesign, and a declared customer id instead of accounts. Each is argued in Section 3 and I can defend it.
- Reading every claim against the code before it went into a document.
- The follow-up discussion: where each invariant is enforced (Section 1), what a concurrent or repeated request returns (Sections 7 and 9), and where to change a business rule (Section 2.5).

## 15. With two more hours

| Priority | What | Why |
|---|---|---|
| 1 | Reserve stock and the coupon in a synchronous block, pay outside the product locks, confirm or restore (exactly once) | Lifts the measured limit: throughput per hot product is about 1 / payment latency. Changes what shoppers see while a payment is in flight (test X9) |
| 2 | Public `GET /rewards/progress`; stop the customer page reading `/admin/report` | Keeps the customer / admin boundary clean |
| 3 | Persist to SQLite behind the same service interface | Survives restarts; a step toward Section 13 |
| 4 | Reconcile `PAYMENT_TIMEOUT` outcomes (outbox plus a status check at the provider) | After a 504 the real charge state is unknown with a real provider |
| 5 | Authentication (customer ids are declared by the client, so anyone can read anyone's history), and per-customer coupon rules | Admin routes are public; coupons are store-wide |

---

**Time spent:** _fill in the approximate hours here before submitting._
