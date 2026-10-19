# DECISIONS

This is the write-up for the checkout and rewards service: a Node.js + TypeScript + Express API that keeps everything in memory and runs as a single instance. The store is at https://ublinox.vercel.app and the API at https://ublinox-api.onrender.com.

File paths below are relative to `backend/src/`. Test IDs such as K12, X3, E1, T4 or CU5 are explained in `docs/TEST_PLAN.md` and `docs/EDGE_CASES.md`, and every error code is in `docs/ERRORS.md`.

What is where:

1. [System invariants](#1-system-invariants)
2. [Requirements and business rules](#2-requirements-and-business-rules) (assumptions, rounding, discounts, coupons)
3. [Material design decisions](#3-material-design-decisions) (14 of them, each with the alternatives)
4. [Transaction, concurrency and idempotency strategy](#4-transaction-concurrency-and-idempotency-strategy)
5. [Locks](#5-locks)
6. [Input validation](#6-input-validation)
7. [Retries and idempotency](#7-retries-and-idempotency)
8. [Error model and descriptions](#8-error-model-and-descriptions)
9. [Edge cases](#9-edge-cases)
10. [Multiple customers: switching users to test concurrency](#10-multiple-customers-switching-users-to-test-concurrency)
11. [Testing](#11-testing)
12. [Implemented vs deferred](#12-implemented-vs-deferred)
13. [Multiple instances and production scale](#13-multiple-instances-and-production-scale)
14. [How I used AI tools](#14-how-i-used-ai-tools)
15. [With two more hours](#15-with-two-more-hours)

---

## 1. System invariants

These are the things that have to stay true however the requests arrive. Each one names the code that enforces it and a test that fails if it breaks.

1. Stock never goes below zero, and what we sold plus what is left always equals what we started with. Checked in `services/checkoutService.ts` while the product lock is held. Tests X3, S1, L1.
2. A cart becomes at most one order. The cart lock plus the check that the cart is still open. K6, K17.
3. One Idempotency-Key gives at most one order. The key is claimed before the first `await`. K12, K13, L3.
4. A coupon is used at most once, and only by a checkout that actually completes. Coupon lock, status check, and the commit block. K18, K11.
5. A failed checkout changes nothing. Every write happens in one block, after all the checks and after payment. K11, X6, E4, T4.
6. We never generate more coupons than `floor(orders / n)`, and never two for the same milestone. `services/couponService.ts`. M1 to M5.
7. Money is whole cents, and the total is never negative or above the subtotal. `domain/money.ts`. K19, K20, E6.
8. An order keeps the prices it was charged, even if the product changes later. The `OrderLine` snapshot. O3.
9. The report matches the stored orders and coupons, and asking for it changes nothing. `services/reportService.ts`. R2, R4, H6.
10. An order belongs to the customer who owned the cart, and a customer's history only lists their own orders. CU3, CU5.

## 2. Requirements and business rules

### 2.1 Things the brief left open

- **Price changes after an item is added.** The cart always shows current prices and the order charges the price at checkout. If the client sends `expectedSubtotalCents` and it no longer matches, checkout answers `409 PRICE_CHANGED` and charges nothing.
- **Stock changes after an item is added.** Adding to a cart does not reserve anything. Checkout checks again and answers `409 INSUFFICIENT_INVENTORY`, saying how many were asked for and how many are left.
- **What counts toward the n-th order.** Orders that actually completed, one per checkout whatever the quantity. Orders that used a coupon count. Failed checkouts and replayed retries do not.
- **When a coupon is created.** When an admin calls `POST /admin/coupons`. One call creates the coupon for the earliest milestone that has not been rewarded yet.
- **Who can use a coupon.** Whoever has the code, once. No expiry and no minimum spend. The percentage is fixed when the coupon is created.
- **What the discount applies to.** The whole order subtotal, rounded half up to the cent, never more than the subtotal.
- **Order statuses.** An order only exists after payment succeeded and the commit went through, so it is always `CONFIRMED`. A cart goes from `OPEN` to `CHECKED_OUT` once.
- **Same key, different request.** Refused with `422 IDEMPOTENCY_KEY_REUSED`. "Same request" means same cart and same coupon.
- **Retry after a failed checkout.** The key is released, so the same key is looked at fresh. That lets a customer fix the cart and try again.
- **Payment.** A fake asynchronous gateway (see the Payment decision).
- **Admin access.** No login. Anything under `/admin/*` is an admin operation.
- **Who a "customer" is.** A demo identity. The browser declares a `customerId` when it creates a cart (three of them in the UI) and the order copies it. That separates carts and history for testing, but it is not access control.

### 2.2 Pricing, rounding and the discount

All money is whole cents: `priceCents`, `subtotalCents`, `discountCents`, `totalCents`. The only place anything is rounded is the discount, once, in `domain/money.ts`.

Take 2 desk lamps at $49.99 with a 10% coupon:

- line total: 4999 × 2 = 9998 cents
- subtotal: 9998
- discount: `floor((9998 × 10 + 50) / 100)` = 1000 (the +50 is what makes halves round up)
- the discount is capped at the subtotal, so it stays 1000
- total: 9998 − 1000 = 8998, so the customer pays **$89.98**

| Subtotal | Exact 10% | Discount | Total | What it shows |
|---|---|---|---|---|
| $10.05 | 100.5¢ | 101¢ | $9.04 | exactly half rounds up |
| $10.04 | 100.4¢ | 100¢ | $9.04 | below half rounds down |
| $10.06 | 100.6¢ | 101¢ | $9.05 | above half rounds up |
| $0.05 | 0.5¢ | 1¢ | $0.04 | smallest case |
| $75.00 at 100% | 7500¢ | 7500¢ | $0.00 | the cap, so never negative |

I used whole cents because floating point cannot be trusted with money (`0.1 + 0.2` is `0.30000000000000004`). I used half-up because it is the usual retail rule and gives the same answer every time. Having one rounding step means there is exactly one rule to explain and test (money tests, K19, K20).

In the report, gross revenue is the sum of subtotals, discounts is the sum of discounts, and net is gross minus discounts, which equals the sum of what was actually charged.

### 2.3 Coupons

- n and x come from `COUPON_EVERY_N_ORDERS` (default 5) and `COUPON_PERCENT_OFF` (default 10). The server refuses to start if they are not valid.
- Milestones reached = `floor(orders placed / n)`. Coupons owed = milestones reached − coupons generated.
- Admin `POST /admin/coupons` creates `SAVE10-AB12CD` style codes for the earliest owed milestone, or answers `409 NO_ELIGIBLE_MILESTONE` and says when the next one is.
- A customer sends `couponCode` at checkout. Case and spaces are ignored. It applies to the whole order.
- The coupon goes from `AVAILABLE` to `REDEEMED` in the same block that saves the order. If the checkout fails for any reason, the coupon stays available.

With n = 5: after 4 orders nothing is owed; after 5 one coupon is owed; once it is generated nothing is owed until order 10; if an admin waits until order 12, two coupons have been owed and each click creates the next one. The 5th order itself pays full price. The coupon is for a later order.

### 2.4 Cart, order and coupon status

A cart is `OPEN` until a checkout commits, then `CHECKED_OUT` forever, and a checked-out cart cannot be edited (409). An order is `CONFIRMED` from the moment it exists. Shipping, cancellation and refunds are out of scope. A coupon is `AVAILABLE` until the order that uses it commits, then `REDEEMED`.

### 2.5 If a rule has to change

- Different n or x: change the two environment variables and restart. The milestone tests use n = 2.
- Round differently: `percentOfCents` in `domain/money.ts`. The money tests and K19 will say what moved.
- Coupon expiry or a minimum spend: add the field in `generateCoupon`, check it next to the "already redeemed" check in checkout, and add an error code and a test next to K8.
- Only orders over some value count toward milestones: the `placedOrders += 1` line in the commit block (tests M6, M7).
- One coupon per customer: store the customer on the coupon and compare it with the cart's customer in checkout.
- Reserve stock before paying: this changes the structure of `checkoutService.ts` (Section 15), and tests X9, E4 and X11 would change on purpose.

## 3. Material design decisions

### Locks

#### Decision: An in-process lock per cart, product and coupon

**Context:** Node runs one piece of JavaScript at a time, so code without an `await` cannot be interleaved with another request. Checkout has to `await` the payment provider, and while it waits another request runs. Two checkouts can both see "1 in stock", both pay, and both commit.

**Options considered:**
1. One global lock around every checkout.
2. No locks. Decrement at the end and fail if stock would go negative.
3. Optimistic concurrency: version numbers and retry on conflict.
4. A lock per resource (cart, product, coupon).

**Choice:** Option 4. `domain/keyedMutex.ts` keeps a first-in-first-out queue per key (`cart:<id>`, `product:<id>`, `coupon:<code>`). Checkout holds the locks for its cart, products and coupon from validation until commit. Cart edits take the cart lock, and admin price or stock changes take the product lock. Section 5 has the details.

**Why:** A global lock is correct but a mug purchase would wait behind an unrelated lamp purchase. Option 2 only finds out about the conflict after payment, so the loser would need a refund. Option 3 makes sense with a database, but in memory it just adds retry loops. Per-key locks only make requests wait when they touch the same thing, and they serve them in the order they arrived.

**Consequences:** Unrelated checkouts run side by side. A slow payment holds its product's lock, so shoppers queue behind it, but the wait is capped (see "Bound every wait"). The locks live in this process's memory, so they only work with one instance (see "In-memory store").

#### Decision: Fixed lock order, cart first, then coupon and products sorted

**Context:** A checkout needs several locks. Two carts holding the same products in a different order could each take one lock and wait forever for the other.

**Options considered:** take locks in cart order; take them with a timeout and retry; take them in one global order.

**Choice:** Lock the cart on its own first, because the list of products is only safe to read once the cart is locked. Then take the coupon and product locks together in one call that sorts the keys.

**Why:** With one global order a wait cycle cannot form, and no timeouts or retries are needed.

**Consequences:** No deadlocks. Test X5 builds the exact deadlock schedule: it hangs when the sorting is removed and passes with it.

### Checkout flow

#### Decision: Check under the locks, then pay, then write everything in one step

**Context:** A checkout touches stock, the coupon, the order list, the cart and the order counter. If another request could see those halfway through, or something failed between two of them, the invariants above would break.

**Options considered:**
1. Pay first, then check and write.
2. Reserve stock, pay, then confirm or give it back.
3. Check everything under the locks, pay, then write everything in one synchronous block.

**Choice:** Option 3, in `services/checkoutService.ts`: checks, price, `await` payment, then one block with no `await` that lowers stock, redeems the coupon, saves the order, closes the cart, bumps the counter and stores the idempotency response.

**Why:** Option 1 charges customers who then lose the race. Option 2 needs a "give it back" path that must run exactly once, plus timers for abandoned reservations. With option 3 the losers are turned away before payment, so no refunds are needed (E4). Once a payment is approved the write cannot fail, because everything was already checked and nothing else can run until it finishes.

**Consequences:** No partial writes and no refund path. Every error before the final block leaves the state untouched. The price is that locks are held while waiting for the payment.

### Idempotency

#### Decision: A required Idempotency-Key on checkout, released on failure

**Context:** Clients retry after timeouts. A retry must not create a second order or take stock twice.

**Options considered:**
1. Deduplicate by cart only, since a cart can become one order.
2. A client-supplied key that only remembers successes.
3. A key that remembers every response, failures included.

**Choice:** Option 2, plus the cart rule from option 1. Checkout needs an `Idempotency-Key` header (8 to 100 characters, letters, digits and `. _ : -`). Before the first `await` the key is claimed as in progress, together with a fingerprint of the cart id and the coupon. On success the 201 is stored and replayed with `Idempotent-Replayed: true`. On any failure the key is deleted.

**Why:** The cart rule alone cannot hand the original response back to a client that lost it. Remembering failures (option 3) would keep replaying "out of stock" even after the customer fixed the cart. Claiming the key synchronously means two identical requests cannot both get it. The character rule also rejects two headers that Node would merge into one `"a, b"` key.

**Consequences:** What every retry situation returns is in Section 7. Finished keys expire after 24 hours (see the next decision). Tests K12 to K15, K23, E2, X8.

### Backpressure and timeouts

#### Decision: Bound every wait: lock-wait timeout, payment timeout, key expiry

**Context:** A load test (`scripts/load-test.ts`, 100 shoppers, 150 ms simulated payment) passed every invariant but showed checkout latency at p95 of about 6 seconds and roughly 8 orders per second. The reason is the decision above: a checkout holds its products' locks while it waits for payment, so shoppers for the same product are served one at a time. Per product that is about 1 divided by the payment time, and with a real provider at around a second it is one order per second for a popular item. That left three risks: the line behind a slow checkout had no limit, a provider that never answers would hold a product's lock forever, and finished idempotency keys were never removed.

**Options considered:**
1. Leave the waits unbounded.
2. Take stock in a synchronous block, release the product locks, pay, then confirm or give the stock back. That removes the queue.
3. Keep the design and put a limit on each wait.

**Choice:** Option 3.

- `LOCK_WAIT_MS` (default 10 s): a request still waiting gives up with `503 SERVER_BUSY` and `Retry-After: 2`. Nothing is written, the customer is not charged, and the key is freed.
- `PAYMENT_TIMEOUT_MS` (default 15 s): `504 PAYMENT_TIMEOUT`. Nothing is written and the locks and key are released. The key is passed on to the provider, so a real provider could recognise a retry.
- `IDEMPOTENCY_TTL_MS` (default 24 h): finished keys are cleaned up lazily, at most once a minute. A late retry of an expired key still cannot duplicate, because the cart is already checked out and the answer is `409 CART_ALREADY_CHECKED_OUT` with the existing `orderId`.

The browser retries `SERVER_BUSY` and `REQUEST_IN_PROGRESS` up to twice with the same key.

**Why:** Option 2 is the right production step, but it changes what shoppers see. While a payment is in flight its units are already taken, so a second shopper is refused even if the first payment then fails (today, test X9 shows that second shopper getting the unit). It also needs a release step that runs exactly once, for stock and for the coupon. For a demo-sized service whose argument is easiest when nothing is written before payment succeeds, that was not worth it. Limiting the waits gives backpressure without touching that argument. With 250 shoppers and `LOCK_WAIT_MS=3000`, checkout p95 stayed at 3.0 s (max 3.3 s) instead of a growing queue, 175 requests were turned away with 503, there were no 5xx errors, and every invariant still held.

**Consequences:** Under a burst some shoppers get a 503 and have to retry. A popular product is still limited to about one order per payment time, and option 2 is what fixes that (Section 15). After a 504 the real outcome is unknown with a real provider, so reconciliation is not built (Section 12). When a waiting request gives up, it still passes its place in line on, otherwise one timeout would block that product for good (test T2). Tests T1 to T8 and L1 to L3.

### Inventory and pricing

#### Decision: No stock reservation in the cart

**Context:** The brief says never oversell, and asks what happens when availability changes before checkout.

**Options considered:** reserve stock when an item is added; reserve for a few minutes when checkout starts; reserve nothing and check at checkout.

**Choice:** Reserve nothing. `PUT` already refuses quantities above current stock, as early feedback, and checkout checks again under the lock.

**Why:** Reserving in carts lets abandoned carts hide stock from real buyers and needs expiry and release logic. Since we check before paying, checking at checkout is enough to never oversell, and the losers are not charged.

**Consequences:** Ten shoppers can each hold the last 3 units in their carts (X1) and only checkout decides. Someone can be refused at checkout after filling a cart. That is fine here, and a short reservation at checkout is the upgrade path.

#### Decision: Charge the price at checkout, guarded by `expectedSubtotalCents`

**Context:** An admin can change a price while a customer still has the old page open.

**Options considered:** freeze the price when the item is added; always charge the current price silently; charge the current price but let the client say what it showed.

**Choice:** Orders use the price at checkout and keep it in the `OrderLine` snapshot. The client may send `expectedSubtotalCents`. If it differs from the current subtotal, up or down, checkout answers `409 PRICE_CHANGED` with both values and charges nothing. Admin price changes take the product lock, so they cannot land between validation and the final write.

**Why:** Freezing the price in the cart means honouring stale prices for as long as the cart exists. Silent repricing charges an amount the customer never saw. The assertion keeps the server in charge and still makes the change visible.

**Consequences:** The UI reloads the cart and asks the customer to confirm (E7, E9). API clients that leave the field out get the current price (E8). Orders stay explainable after prices change (O3).

### Money

#### Decision: Whole cents with one half-up rounding step

**Context:** Totals have to be exact and always come out the same. Floats drift.

**Options considered:** JavaScript numbers in dollars; a decimal library; whole cents.

**Choice:** Whole cents everywhere. The only rounding is the discount, `floor((subtotal × percent + 50) / 100)`, capped at the subtotal. Section 2.2 has the rules and examples.

**Why:** Integer arithmetic is exact at these sizes and needs no extra dependency. One rounding point means one rule to explain and test.

**Consequences:** Every money field in the API ends in `Cents` and the UI does the formatting. A decimal type would only be needed for fractional cents, such as tax rates or currency conversion.

### Coupons

#### Decision: Admin creates one coupon per milestone, counted from completed orders

**Context:** "Every n-th successfully placed order makes one coupon available", generated when an administrator asks, at most once per milestone.

**Options considered:**
1. Apply the discount to the n-th order automatically.
2. Create the coupon automatically when the n-th order commits.
3. Let the admin generate the coupon for the earliest unrewarded milestone.

**Choice:** Option 3 (`services/couponService.ts`). Milestones reached = `floor(placedOrders / n)`, coupons owed = reached minus generated. One call creates one coupon or answers `409 NO_ELIGIBLE_MILESTONE`.

**Why:** The brief describes an administrator requesting generation, and option 1 contradicts "makes a coupon available". Generation has no `await`, so two admin calls at once cannot both create the coupon for the same milestone (M5). Working out "owed" from counts gives "one per milestone" without extra bookkeeping.

**Consequences:** If the admin is late, several milestones can be owed and each call rewards the earliest (M4). Someone could split one purchase into n small orders to unlock a coupon faster. Without accounts that is acceptable, and fixing it needs authentication.

### Persistence

#### Decision: In-memory store, exactly one instance

**Context:** The brief allows an in-memory store if the invariants still hold under overlapping requests, and asks how production would differ.

**Options considered:** SQLite; PostgreSQL; in-memory maps.

**Choice:** In-memory maps (`store.ts`), loaded from `data/products.json`. `render.yaml` pins the deployment to one instance.

**Why:** Reviewers need no setup or credentials, tests are fast and deterministic, and the concurrency problem stays visible in the code instead of being hidden inside a database. The tests show the invariants hold under real overlapping HTTP requests.

**Consequences:** A restart or redeploy wipes everything: orders, carts, coupons and idempotency keys. A retry after a restart therefore gets `404 CART_NOT_FOUND`, not a duplicate order. Two instances would each have their own stock and locks and could oversell. Section 13 covers the move to a database.

### Payment

#### Decision: A fake payment gateway that is asynchronous

**Context:** No real payment integration is needed, but the design has to cope with payment being slow or failing.

**Options considered:** treat checkout as payment success with no payment step; a synchronous stub; an asynchronous fake behind an interface.

**Choice:** `domain/payment.ts` defines a `PaymentGateway` interface and a `FakePaymentGateway` that waits `PAYMENT_DELAY_MS` (150 ms by default), records every charge, and can be told to decline (`declineNext`) or never answer (`hangNext`).

**Why:** With no payment step there is no `await` in checkout, which hides the exact race the brief asks about. The asynchronous fake recreates the window in which other requests run, and it makes declines, timeouts and "who was charged" testable (X9, E4, T4).

**Consequences:** A real provider can replace the fake behind the same interface. Webhooks, duplicate callbacks, reconciliation and refunds are not modelled.

### API

#### Decision: Demo customers are a declared id, each with their own cart and history

**Context:** Testing "many customers, one product" and showing order history per customer needs more than one shopper, but the brief says authentication is not required.

**Options considered:**
1. One anonymous shopper per browser, with history kept in `localStorage`.
2. Real accounts with login.
3. A `customerId` declared on the cart and copied to the order, with three demo customers to pick from in the UI.

**Choice:** Option 3. `POST /carts` takes an optional `customerId` (lower-case letters, digits and dashes, up to 40). The order copies it from the cart. `GET /orders?customerId=` returns that customer's orders with their items, newest first. The id is required there, so the endpoint cannot be used to list every order. The admin order list shows the customer. The UI keeps one open cart per customer and ignores a slow response that finishes after the user has switched. Section 10 has the results.

**Why:** Option 1 ties history to one browser and cannot show two shoppers competing. Option 2 is a big feature the brief does not ask for. Option 3 is a few lines in the service, keeps history on the server, and makes the main scenarios easy to try by hand and by script.

**Consequences:** Nothing proves who a customer is, so anyone could read another customer's history by guessing the id. That is fine for a demo and it is listed under production steps (Section 15). Carts and orders created without a customer (the load tests, API clients) have `customerId: null` and still work. Tests CU1 to CU8.

#### Decision: `PUT` sets the quantity, there is no "add one" endpoint

**Context:** Customers double-click "Add", and clients retry requests.

**Options considered:** a `POST` that increments; a `PUT /items/{productId}` with an absolute quantity.

**Choice:** `PUT /carts/{id}/items/{productId}` with `{ quantity: 1 to 99 }` adds the line or replaces its quantity. `DELETE` removes it.

**Why:** A retried "add one" adds twice, while a retried "set to 2" does no harm. So deliberate quick clicks are not lost, the UI disables "Add" until the previous update comes back.

**Consequences:** Cart edits are idempotent (X12, E3). The client has to know the current quantity, which it always has from the last cart response.

#### Decision: One error envelope with stable codes

**Context:** Errors need to be distinguishable and useful to an API client.

**Options considered:** an HTTP status plus free text; RFC 7807 problem details; a custom envelope with a stable code.

**Choice:** Every error is `{ error: { code, message, details } }`, with 24 codes in `domain/errors.ts`. Section 8 lists them.

**Why:** Clients can branch on a stable `code`, and `details` carries what they need to act, such as how many are available or the existing `orderId`. It is simpler than RFC 7807 and carries the same information.

**Consequences:** Adding a failure means adding a code and documenting it in `docs/ERRORS.md`. A client mistake never turns into a 500 (an oversized body now gives 413 and a malformed URL gives 400; both returned 500 until the running server was probed for them).

---

## 4. Transaction, concurrency and idempotency strategy

This is how the decisions above fit together on `POST /carts/{id}/checkout`:

1. Validate the header and body (Section 6).
2. Claim the Idempotency-Key. If it was used before, replay the stored answer or answer 409 or 422.
3. Lock the cart. Check that it is open and not empty.
4. Lock the coupon and the products, sorted. Check stock, the coupon, and the price the client expects.
5. `await` the payment, giving up after `PAYMENT_TIMEOUT_MS`.
6. Write everything in one block with no `await`, and store the response under the key.
7. In a `finally`: release the locks. If anything failed, delete the key. Nothing was written.

Which operations take which lock is in Section 5. What a client does after each outcome is in Section 7.

## 5. Locks

### Why Node needs locks at all

Node is single-threaded, but the payment `await` is a moment when other requests run while a checkout is half done. Two shoppers, one last print:

1. A takes the product lock for the print. B asks for it and waits.
2. A checks the stock (1) and goes ahead. A waits 150 ms for payment. B is still waiting.
3. A saves the order and the stock drops to 0. A releases the lock.
4. B gets the lock, sees stock 0, and gets `409 INSUFFICIENT_INVENTORY`. B was never charged.

Without the lock, B would also have seen stock 1 and the stock would end at -1.

### Which operation takes which lock

| Operation | Locks | What it protects |
|---|---|---|
| Checkout | the cart first, on its own; then the coupon and every product in the cart, sorted, in one call | nothing it validated can change before it saves |
| Add, change or remove a cart item | the cart | a cart cannot change while it is being paid for (K21) |
| Admin price or stock edit | the product | stock and price cannot change mid-checkout (K24, X11) |
| Generate a coupon | none, there is no `await` in it | one coupon per milestone (M5) |
| Reports, order lists, cart view, product list | none, they only read and finish synchronously | they never see a half-finished order |

### How the mutex behaves

`domain/keyedMutex.ts` keeps a queue of promises per key. A request runs once the one in front of it has released.

- Keys are sorted and de-duplicated before taking them, so two checkouts can never wait on each other (X5).
- Waiting has a limit. After `LOCK_WAIT_MS` the request gets `503 SERVER_BUSY` with `Retry-After: 2` (T1, L2).
- A request that gave up still passes its place on when its turn arrives. Without that, one timeout would block everything behind it (T2).
- If a request needs several keys and times out on the second, the first is released (T3b).
- Locks are released in a `finally`, on success and on every error, and a second release is ignored (T5, X8).
- Order is first in, first out per key. That comes from how the promise chain is built and no test asserts the order.

### Limits

- The locks live in one process. Two instances would not see each other's locks, so scaling out needs the database approach in Section 13.
- Locks are held while waiting for payment, so one popular product handles about one order per payment time. Measured with a 150 ms payment, that was about 8 orders per second overall. Section 15 has the fix.
- Waiting is first in, first out per product, not per customer, so someone can wait behind many others.

## 6. Input validation

Every request goes through three checks before any business rule runs. Each one answers with a 4xx and writes nothing.

1. **Parse.** `express.json` with a 16 KB limit. A bad body gives `400 INVALID_JSON`, a big one `413 PAYLOAD_TOO_LARGE`, an unsupported type `415 UNSUPPORTED_MEDIA_TYPE`.
2. **Shape.** A zod schema per endpoint in `http/app.ts`, run by `parse()`. Problems give `400 VALIDATION_ERROR`.
3. **Header.** The checkout key has to be 8 to 100 characters of letters, digits and `. _ : -`. Otherwise `400 IDEMPOTENCY_KEY_REQUIRED`.

What each input has to look like:

| Input | Rule |
|---|---|
| Item quantity | whole number from 1 to 99, nothing else in the body |
| `couponCode` | text, 1 to 40 characters after trimming; case and surrounding spaces are ignored |
| `expectedSubtotalCents` | whole number, 0 or more, optional |
| Admin `priceCents` and `inventory` | whole numbers, up to 100 000 000 and 1 000 000; at least one of them |
| `limit` and `offset` | 1 to 100 (default 20) and 0 or more (default 0) |
| `customerId` | lower-case letters, digits, dashes, 1 to 40; required to list a customer's orders |
| Ids in the path | not pattern-checked; an unknown id gives 404 |
| Server settings | `COUPON_*`, `LOCK_WAIT_MS`, `PAYMENT_TIMEOUT_MS`, `IDEMPOTENCY_TTL_MS` must be positive whole numbers or the server will not start (T8) |

A few things worth knowing:

- Every schema is strict, so an unknown field is a 400 and not silently ignored. A typo like `qty` cannot slip through.
- `VALIDATION_ERROR` lists every problem it finds, as `details.issues: [{ path, message }]`, so a form can highlight all of them at once.
- A body sent with the wrong content type counts as empty, so a required field is reported missing. A JSON array gives `VALIDATION_ERROR`, and a bare `null` or number gives `INVALID_JSON`.
- Input validation asks whether the request is well formed (a 400). State validation asks whether it is allowed right now (stock, cart status, coupon) and runs under the locks (a 409 or 422). I kept the two separate on purpose.
- The browser also limits quantities, but only to be helpful. The server never relies on it.

Probing the running server turned up two real gaps: a body over 16 KB and a malformed URL both returned 500. Both are fixed. Tests: P3, P5 to P8, A5, A6, A11, K2, K10, K22, K23, U2, U3, H5, CU2, CU4, E10, T8.

## 7. Retries and idempotency

### Who retries

- **The browser**, automatically, on a network error, `REQUEST_IN_PROGRESS` or `SERVER_BUSY`. Up to two more tries after 0.8 s and 1.6 s, always with the same key. Any other error is shown to the customer.
- **The customer**, after fixing a cart or after a decline. They check out again, and the same key is fine because a failure frees it.
- **An API client**, after any timeout. It sends the same request with the same key.

The UI also ignores clicks while a checkout is running, so a double-click sends one request.

### What happens to a key

It starts as nothing. When a checkout arrives the key is claimed as "in progress" (before the first `await`, together with a fingerprint of the cart and coupon). If the commit succeeds the 201 is stored under the key as "completed", and it is swept after 24 hours. If anything fails before the commit, the key is deleted.

### What each situation returns

| Situation | Response | Why it is safe | Tests |
|---|---|---|---|
| Response lost, same key sent again | the stored 201 with `Idempotent-Replayed: true` | nothing runs a second time | K12, E2 |
| Same key while the first request is still running | `409 REQUEST_IN_PROGRESS`; the browser waits and retries | only one request can claim the key | K13, L3 |
| New key for a cart that already became an order | `409 CART_ALREADY_CHECKED_OUT` with the order id | a cart becomes one order | K17, E2 |
| Same key for a different cart or coupon | `422 IDEMPOTENCY_KEY_REUSED` | the fingerprint differs | K14 |
| Out of stock, coupon used, or price changed | a 409; fix the cart and send again with the same key | the failure freed the key and wrote nothing | X7, X8, E7 |
| Payment declined | 402; send again with the same key | nothing was written | K11, X9 |
| `503 SERVER_BUSY` | wait for `Retry-After`, send again with the same key | it never reached payment | T1 to T3, L2 |
| `504 PAYMENT_TIMEOUT` | not retried automatically; check whether the provider charged | nothing is recorded here, and the key goes to the provider so it can recognise a retry | T4, T5 |
| Key older than 24 hours | `409 CART_ALREADY_CHECKED_OUT` | the cart check still stops a second order | T6 |
| Server restarted | `404 CART_NOT_FOUND` | the carts are gone as well | none |
| Cart edit sent twice | same cart state | `PUT` sets the quantity, it does not add | X12, E3 |

One call is not idempotent on purpose: `POST /admin/coupons`. Each call creates the next owed coupon, so repeating it after a lost response can create a second one if another milestone is owed. Two calls at once are safe (M5). I left that as is.

## 8. Error model and descriptions

Every error has the same shape and clients should branch on `code`:

```json
{ "error": { "code": "INSUFFICIENT_INVENTORY", "message": "Not enough stock for one or more items.",
             "details": { "lines": [{ "productId": "p-print", "requested": 4, "available": 3 }] } } }
```

Statuses: 400 for a request that is malformed or invalid, 402 for a declined payment, 404 for something missing, 409 for a valid request that conflicts with the current state, 413 and 415 for a body that is too large or the wrong type, 422 for a request that is well formed but makes no sense, 503 when the server is busy, 504 when the payment provider is too slow, and 500 only for unexpected server errors.

| Code | HTTP | Meaning | `details` |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | a field is missing, the wrong type, out of range or unknown | `issues[]` |
| `INVALID_JSON` | 400 | the body is not valid JSON, or is `null` | none |
| `BAD_REQUEST` | 400 | malformed URL encoding | none |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | checkout without a valid key | none |
| `PAYMENT_DECLINED` | 402 | the provider declined; nothing charged or reserved | `reason` |
| `CART_NOT_FOUND` | 404 | no such cart | `cartId` |
| `PRODUCT_NOT_FOUND` | 404 | no such product | `productId` |
| `ITEM_NOT_IN_CART` | 404 | removing a product that is not in the cart | `productId` |
| `ORDER_NOT_FOUND` | 404 | no such order | `orderId` |
| `COUPON_NOT_FOUND` | 404 | no such coupon code | `code` |
| `ROUTE_NOT_FOUND` | 404 | unknown path or method | none |
| `INSUFFICIENT_INVENTORY` | 409 | more asked for than is in stock | `lines[]` with requested and available |
| `CART_ALREADY_CHECKED_OUT` | 409 | the cart is already an order | `cartId`, `orderId` |
| `COUPON_ALREADY_REDEEMED` | 409 | another order used the coupon | `code` |
| `PRICE_CHANGED` | 409 | the subtotal the client showed differs from the current one | old and new subtotal, lines |
| `REQUEST_IN_PROGRESS` | 409 | the same key is still being processed | none |
| `NO_ELIGIBLE_MILESTONE` | 409 | no unrewarded milestone has been reached | `placedOrders`, `nextMilestoneAtOrder` |
| `PAYLOAD_TOO_LARGE` | 413 | body over 16 KB | none |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | the body type cannot be parsed | none |
| `CART_EMPTY` | 422 | checkout with no items | `cartId` |
| `IDEMPOTENCY_KEY_REUSED` | 422 | the key belongs to a different request | none |
| `SERVER_BUSY` | 503 | waited longer than `LOCK_WAIT_MS` for a lock | `resource` |
| `PAYMENT_TIMEOUT` | 504 | no answer within `PAYMENT_TIMEOUT_MS`; nothing recorded | none |
| `INTERNAL_ERROR` | 500 | unexpected error, logged | none |

The rules behind it:

- A client mistake never returns 500. A 5xx means a server problem or an overloaded server.
- A failed request writes nothing. Checkout reports the first failing check in a fixed order (the 12 steps are in `docs/ERRORS.md`).
- `message` is for people and can change. `code` and `details` are the contract.
- In the browser every error shows up as a toast reading `CODE: message`. `PRICE_CHANGED` is special: the cart reloads and the customer is asked to confirm. `SERVER_BUSY` and `REQUEST_IN_PROGRESS` are retried quietly.

## 9. Edge cases

Every case below has a test. `docs/EDGE_CASES.md` walks through the assignment's own list one by one.

**Duplicates and retries**
- Customer double-clicks "Place order": one order, one charge, and the second request gets a 409 (E2, K13, L3).
- A new key on every click for the same cart: `409 CART_ALREADY_CHECKED_OUT` with the order id (E2, K17).
- The response is lost after a success: the retry returns the same order (K12).

**Stock races**
- Two orders for the last unit: the first is confirmed, the second gets 409, is not charged, and its cart stays open (E1, K16).
- 50 shoppers and 3 units: exactly 3 orders (X3).
- 3 in stock, one customer buys 1, then another asks for 3: they are told exactly 2 are left, and can then buy 2 (E5, X4).
- Several people race for the last unit: only the winner is charged, so nobody needs a refund (E4).
- One item in a multi-item cart sells out: the whole checkout is refused and the other items are untouched (X6).
- The winner's payment is declined: the next shopper gets the unit (X9).
- Two carts list the same products in opposite order: no deadlock (X5).
- Stock and amounts are never negative (E6, S1).

**Cart**
- "Add" clicked three times: each deliberate click counts, a duplicated request does not (E3, X12).
- Cart edited while it is being checked out: the edit waits, then gets 409 (K21).
- Last item removed, then checkout: `422 CART_EMPTY` (D5).

**Pricing**
- An admin changes a price while the page is open: `409 PRICE_CHANGED` and the cart reloads (E7, E9).
- A price change during a payment: it waits, and the order in flight pays the price it validated (X11).
- A client that leaves out `expectedSubtotalCents` is charged the current price (E8).

**Coupons**
- The same coupon in two carts at once: one wins, the other gets 409 (K18, X13).
- A failed checkout leaves the coupon available (K11).
- Admin generates twice or at the same moment: one coupon per milestone (M3, M5).
- A lower-case code with spaces is accepted (K9). A 100% coupon gives a $0.00 total, and half a cent rounds up (K19, K20).

**Failures**
- Payment declined: 402, nothing written (K11).
- Payment never answers: 504 after 15 s, with locks and key released (T4, T5).
- Slow checkout and a long line: 503 after 10 s, never charged, retry works (T1 to T3, L2).

**Bad input**
- Oversized body, bad URL, non-object JSON, wrong content type, bad quantities: always a 4xx with a specific code and never a 500 (P5 to P8, A5, A11).

**Several customers**
- Two customers hold the last unit: one order, the other refused, and both histories are right (CU5).
- One customer's order leaves other customers' carts and history alone (CU6).

**Server**
- A restart loses all in-memory data. This is a known limit of the design.

## 10. Multiple customers: switching users to test concurrency

**The problem.** The app started with one anonymous shopper per browser. One person could not make two shoppers compete from the UI, so concurrency only showed up in scripts and tests, and order history could not be told apart per customer.

**What I added.** Three demo customers, chosen from a switcher in the header ("Shopping as ..."): Aisha Khan (`u-aisha`), Ben Carter (`u-ben`) and Chloe Martin (`u-chloe`).

How it works (the decision is in Section 3):

- `POST /carts` declares the `customerId`, the order copies it from the cart, `GET /orders?customerId=` returns that customer's history, and the admin order list shows who ordered.
- The browser keeps one open cart per customer and remembers who was selected across reloads.
- A response that arrives after the user has switched is ignored, so one customer's slow checkout cannot overwrite another customer's screen.
- This is not authentication. Nothing proves who a customer is.

**What was checked.** A real Chrome browser was driven by script against the app, locally and on the deployed site, and the results were read from the page.

1. Aisha and Ben both put the last art print in their carts. Ben checked out first and got an order for $75.00. Aisha's cart then said "only 0 left", her checkout was refused with `INSUFFICIENT_INVENTORY`, no receipt appeared and her cart was untouched. Ben's history showed 1 order and Aisha's none.
2. Switching from Aisha (1 item in the cart) to Ben showed an empty cart, and Aisha's item was still there when I switched back.
3. After a reload the selected customer and their cart were restored.
4. In Admin, the order list showed "Ben Carter" as the customer.
5. A checkout was started as Chloe and the user switched to Ben straight away. Chloe's order was still recorded, and the screen stayed on Ben with an empty cart and no receipt.
6. On the deployed site (Vercel plus Render), switching to Chloe showed an order that had been placed for her through the API, and adding something to Chloe's cart did not touch Ben's.

The automated versions of these are CU1 to CU8 (tagging, per-customer history, two customers racing, separate carts), E1 and E4 (last-unit races), and L1 to L3.

To try it yourself in two minutes: set the art print's stock to 1 in Admin, add it to Aisha's cart, switch to Ben and add it, check out as Ben, switch back to Aisha and check out.

## 11. Testing

### The layers

- **Automated tests in process, 140 of them** (`cd backend && npm test`). Each test starts its own real HTTP server on a random port with fresh data and a fake payment that waits a little, so concurrent requests really do overlap.
- **Live black-box checks, 37** (`npm run edge-cases`). They use only the public HTTP API, so they work against any running server.
- **A load test** (`USERS=100 npm run load`). Four phases: a race on the limited product, mixed shoppers with admin price changes happening at the same time, double-clicks, and a coupon race. Afterwards it checks stock, order counts, revenue, coupons and status codes.
- **Real-browser checks** by script: switching customers, the last-unit scenario, switching during a checkout, and the deployed site (Section 10).

### The automated tests by file

| File | Tests | What it protects |
|---|---|---|
| `endpoints.test.ts` | 54 | every endpoint against bad input, state conflicts and malformed requests |
| `customers.test.ts` | 16 | customer tagging, per-customer history, two customers racing, separate carts |
| `contention.test.ts` | 14 | many shoppers, one product (X1 to X14) |
| `edgeCases.test.ts` | 11 | the assignment's edge-case list (E1 to E10) |
| `orderHistory.test.ts` | 11 | the admin order list and pagination |
| `hardening.test.ts` | 10 | lock-wait timeout, payment timeout, key expiry, config checks (T1 to T8) |
| `checkout.test.ts` | 9 | overselling, same-cart races, retries, declines, price snapshots |
| `coupons.test.ts` | 5 | milestones, coupon races, report reconciliation |
| `money.test.ts` | 4 | rounding, no float drift, totals never negative |
| `invariants.test.ts` | 3 | 60 random overlapping operations (3 seeds), then every invariant |
| `load.test.ts` | 3 | 120 shoppers at once, shedding when the line is too long, 40 double-clickers |

### Would the tests notice a bug?

Each protection was switched off on purpose to check that the tests notice:

- Locks switched off: X3, X4, X11, X13, X14, K16 to K18, K21, S1, L1 and L2 fail.
- Lock sorting removed: X5 hangs and times out.
- Lock-wait timeout removed: T1 fails.
- A waiter that gave up no longer passes its place on: T2 fails.
- A failed multi-key lock attempt keeps what it already took: T3b fails.
- Payment timeout removed: T4 fails.
- Key cleanup removed: T6 fails.

The whole suite was also run several times in a row with no flaky failures.

### Load and live results

| Run | Where | Shoppers | `LOCK_WAIT_MS` | Orders | Checkout p50 / p95 / max | Turned away (503) | 5xx | Invariants |
|---|---|---|---|---|---|---|---|---|
| A | laptop | 100 | 10 s | 81 (8.0/s) | 1.2 s / 6.3 s / 6.3 s | 0 | 0 | all pass |
| B | laptop | 250 | 3 s | 63 (8.9/s) | 3.0 s / 3.0 s / 3.3 s | 175 | 0 | all pass |
| C | deployed API (Render free plan) | 60 | 10 s | 67 (4.3/s) | 0.6 s / 4.4 s / 4.8 s | 0 | 0 | all pass |

Latency grows with the number of shoppers for the same product, because they are served one at a time, and the lock-wait timeout caps it. The deployed run is slower because the free instance has very little CPU and every request crosses the internet.

On the deployed API, 36 of the 37 live checks pass on a freshly restarted instance. The one that does not (P8, a malformed URL) returns Render's own `520`, because its proxy rejects that URL before the app sees it. An earlier failure of K5 came from data the load test had left behind, not from a bug.

### What is not covered

- There are no automated frontend tests. The UI is small, it was checked by hand and with a browser script, and the brief says the backend is what matters.
- The payment provider is a fake, so webhooks and reconciliation are not exercised.
- Several server instances are not supported by design (Section 13).
- The load test is a burst, not a long soak.

## 12. Implemented vs deferred

**Built**
- Catalog: 6 seeded products, with admin price and stock edits.
- Cart: create, view with live prices and stock warnings, set a quantity, remove.
- Checkout: idempotent, locked, validate then pay then commit, the price-change guard, a bounded lock wait (503) and a payment timeout (504).
- Orders: item snapshots, `CONFIRMED` status, `GET /orders/{id}`, a paginated admin list, and history per demo customer.
- Customers: three demo customers with separate carts and history.
- Coupons: milestones, admin generation, single use, redeemed in the same step as the order.
- Pricing: subtotal, discount and total in cents.
- Payment: an asynchronous fake that can decline or hang, with a charge log and the key passed on to the provider.
- Admin: report, coupons, order history, catalog edits.
- Storage: in memory, one instance, idempotency keys expire after 24 hours.
- Frontend: a small React store with a customer switcher, per-customer order history and an admin page.
- Deployment: Render for the API (one instance) and Vercel for the store.

**Left out on purpose**
- Creating or deactivating products, and cart expiry (not in the brief).
- Shipping, cancellation and refunds.
- Coupon expiry, a minimum spend, per-customer limits, and an idempotent generate call.
- Taxes and shipping costs.
- A real payment provider, webhooks, and reconciling after a 504.
- Authentication and authorisation, and real accounts.
- A database, so data survives restarts.
- Automated frontend tests.
- Deploying on push. Neither service receives push events, so deploys are commands I run.
- Reserving stock before payment, to lift the per-product throughput limit (Section 15).

## 13. Multiple instances and production scale

State and locks only work inside one process. With several instances the plan is:

| Today (one process) | Production |
|---|---|
| In-memory maps | PostgreSQL as the single source of truth |
| Product lock plus a stock check | `UPDATE products SET inventory = inventory - $q WHERE id = $id AND inventory >= $q`; no row updated means out of stock |
| Coupon lock plus a status check | `UPDATE coupons SET status = 'REDEEMED' WHERE code = $c AND status = 'AVAILABLE'` |
| Cart lock | `SELECT ... FOR UPDATE` on the cart row |
| Idempotency map | a table with a unique key, inserted first to claim it, cleaned up by age |
| Uniqueness in code | `UNIQUE(orders.cart_id)` and `UNIQUE(coupons.milestone)`, so the database rejects duplicates even if the code is wrong |
| Payment inside the locked section | two transactions: reserve stock and claim the coupon, then after the provider answers confirm or release in a compensating transaction. Never hold database locks during a network call. |
| Lost callbacks | an outbox table and a reconciliation job; webhooks deduplicated by the provider's event id |
| Declared `customerId` | real accounts, with carts and orders checked against the logged-in customer |
| Report computed on every read | a summary table or a read replica as volume grows |

I would do it in this order: the database and unique constraints, then the conditional updates, then the two-phase payment, then reconciliation. A distributed lock such as Redis is usually unnecessary once the conditional updates and constraints are in place.

## 14. How I used AI tools

I used Claude (Claude Code) throughout, and I want to be plain about the split. **Claude wrote most of the code, the tests, the diagrams and the documents.** I decided the direction, rejected what did not fit the brief, asked for the checks, used the app myself, and read the results. This is roughly how it went.

**Requirements.** I gave Claude the brief. It listed the invariants, the gaps in the wording and a proposed answer for each. The answers are in Section 2, and `docs/REQUIREMENTS.md` maps every requirement to the code and a test and marks the gaps.

**Architecture and choices.** Claude drafted options and diagrams for the components, the layers and the checkout sequence. I rejected the over-built ones (below) and kept a single process with explicit locks. The sequence diagram was later checked against the code.

**Implementation.** Claude wrote the services, validation, error model and tests. We ran the tests, then switched each protection off to confirm the tests fail without it (Section 11).

**Edge cases.** I supplied the list from the assignment. Claude turned each into a test and added more by probing the running server with unusual requests. That probing found two real 500s.

**Business rules.** Claude implemented the rounding, discount and milestone rules. The worked examples in Section 2.2 were checked against the formulas, and there are tests for half-cent rounding, the cap and a 100% coupon.

**End-to-end checks.** Claude wrote the live scripts and the load test. We ran them against the local and the deployed server, and a real browser was driven for the customer scenarios in Section 10.

**Documents.** Claude generated the error catalogue, test plan, edge-case notes and this file. The numbers and codes were compared against the code, which turned up some drift (items 4 and 8 below).

### Where the AI's output was wrong or had to be redirected

1. **Scope.** The first architecture proposals added AWS infrastructure (a load balancer, a firewall, NAT, a multi-zone database) and then a SQLite and PostgreSQL layer. I rejected that. The brief allows an in-memory store and rewards reasoning more than infrastructure. We went back to a single process with explicit locks, I had the AWS diagram deleted from the repository, and the database discussion moved to Section 13.
2. **Tests that did not test what they claimed.** Three generated tests meant to send a request "mid-checkout" built the Supertest request without sending it, because Supertest only sends when awaited. They passed by luck. A failing price-change test (X11) exposed it, and the requests are now started explicitly.
3. **A deadlock test that could not deadlock.** The first X5 passed even with lock sorting removed, so it proved nothing. It was rebuilt with a third shopper holding a product, which does deadlock when the sorting is removed.
4. **A diagram that did not match the code.** A generated sequence diagram used error codes that do not exist (`OUT_OF_STOCK`, `PAYMENT_FAILED`). It was caught by comparing it with `domain/errors.ts`.
5. **Bugs found by probing, not by the generated tests.** A body over 16 KB and a malformed URL both returned 500. They now give 413 and 400 (tests P5 and P8).
6. **A load test that reported a false failure.** The first `load-test.ts` reset a product's stock to a value read at the start, which broke its own stock check halfway through. The server's order, revenue and coupon numbers all matched, so the fault was in the script and we fixed it there before touching the service.
7. **A problem I found by using the UI.** The receipt had a "send the same checkout again" button exactly where the Checkout button had been. One click could show "Replayed", which looked like an error even though the server had behaved correctly. I asked for it to be redone: Checkout ignores clicks while a request runs, network failures are retried quietly with the same key, and the receipt button and a "concurrency demo" were removed.
8. **A wrong claim about deployment.** The README said the API redeploys on every push. After a push the deploy list still showed the old commit: a service created from a public repository URL gets no push events. The deploy was triggered by command and the README was corrected.
9. **A race in the user-switching design.** A checkout started by one customer could finish after the user had switched and draw that customer's new cart over the next customer's screen. A guard now drops results for a customer who is no longer selected, and it was confirmed in a real browser (scenario 5 in Section 10).

### What stays my responsibility

- The trade-offs: pay-then-write instead of reserving stock, a limited queue instead of a redesign, and a declared customer id instead of accounts. Each is argued in Section 3.
- Being able to explain and change any of it, since it is my submission. The numbers in these documents come from commands that were run (tests, load runs, live checks) or from the code.
- The follow-up discussion: where each invariant is enforced (Section 1), what a concurrent or repeated request returns (Sections 7 and 9), and where to change a business rule (Section 2.5).

## 15. With two more hours

1. **Take stock and the coupon in one synchronous block, pay outside the product locks, then confirm or give them back (exactly once).** This removes the measured limit of about one order per payment time for a popular product. It changes what shoppers see while a payment is in flight (test X9).
2. **A public `GET /rewards/progress`**, so the customer page stops reading `/admin/report` and the customer and admin sides stay separate.
3. **Persist to SQLite behind the same service interface**, so data survives restarts. A step toward Section 13.
4. **Reconcile `PAYMENT_TIMEOUT` outcomes** with an outbox and a status check at the provider, because after a 504 the real charge state is unknown with a real provider.
5. **Authentication, and per-customer coupon rules.** Customer ids are declared by the client, so anyone can read anyone's history, admin routes are public, and coupons are store-wide.

---

**Time spent:** _fill in the approximate hours here before submitting._
