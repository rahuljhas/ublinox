# Test Plan

## Goals

1. Every endpoint is exercised on its success path and on each error it can return.
2. The business invariants hold under **concurrent** and **repeated** requests, not only in a single happy-path sequence.
3. Each test would fail on a plausible wrong implementation (verified for the race tests by disabling the locks: 3 tests fail).

## Invariants under test

| ID | Invariant |
|---|---|
| I1 | Stock never goes below zero; sold + remaining = starting stock for every product |
| I2 | A cart produces at most one order |
| I3 | One Idempotency-Key produces at most one order; a retry returns the same order |
| I4 | A coupon is redeemed at most once, and only by a checkout that succeeded |
| I5 | A failed checkout writes nothing (stock, coupon, cart, order count unchanged) |
| I6 | Coupons generated ≤ floor(placed orders / n); at most one coupon per milestone |
| I7 | 0 ≤ total ≤ subtotal; all money is integer cents; discount rounds half up |
| I8 | An order keeps the prices it was charged, even if products change later |
| I9 | The report equals what the orders and coupons say, and reading it changes nothing |

## How tests run

- `cd backend && npm test` (Vitest + Supertest).
- Each test starts a real HTTP server on a random port with a fresh in-memory store, so tests are isolated and concurrent requests really overlap in the event loop.
- The fake payment gateway has a delay (20–50 ms) so racing requests overlap during the payment `await`, and `declineNext` forces a payment failure.
- Test config: coupon every **n = 2** orders, **x = 10%**. Test products: `p-cheap` $1.99 ×100, `p-mid` $14.50 ×50, `p-last` $75.00 ×3.

### Live black-box run

`backend/scripts/edge-cases.ts` runs 37 of these cases against a **running** server using only HTTP, and prints a PASS/FAIL table:

```bash
cd backend && npm start          # terminal 1
cd backend && npm run edge-cases # terminal 2 (BASE_URL=... to target another host)
```

### Bugs found by edge-case probing

| Case | Before | After |
|---|---|---|
| P5 body over 16 KB | 500 `INTERNAL_ERROR` | 413 `PAYLOAD_TOO_LARGE` |
| P8 malformed URL encoding | 500 `INTERNAL_ERROR` | 400 `BAD_REQUEST` |
| K23 two `Idempotency-Key` headers | merged into one key `"a, b"` and accepted | 400; keys allow only letters, digits and `. _ : -` |

## Cases by endpoint

### Platform

| ID | Case | Expected |
|---|---|---|
| P1 | `GET /health` | 200 `{ status: "ok" }` |
| P2 | Unknown route | 404 `ROUTE_NOT_FOUND` |
| P3 | Malformed JSON body | 400 `INVALID_JSON` |
| P4 | CORS preflight `OPTIONS` | 204 with `Idempotency-Key` allowed |
| P5 | Body over 16 KB | 413 `PAYLOAD_TOO_LARGE` (was 500 before the fix) |
| P6 | Body sent as `text/plain` | treated as empty → 400 `VALIDATION_ERROR` |
| P7 | Unsupported method on a known path | 404 `ROUTE_NOT_FOUND` |
| P8 | Malformed URL encoding (`/carts/%E0%A4%A`) | 400 `BAD_REQUEST` (was 500 before the fix) |

### `GET /products`

| ID | Case | Expected |
|---|---|---|
| G1 | List | 200, every seeded product with integer `priceCents` and `inventory` |
| G2 | After a checkout | inventory reduced by the quantity bought |

### `POST /carts`, `GET /carts/{id}`

| ID | Case | Expected |
|---|---|---|
| C1 | Create | 201, `OPEN`, no items, subtotal 0 |
| C2 | Two creates | different ids |
| C3 | Get unknown cart | 404 `CART_NOT_FOUND` |
| C4 | View prices | line totals and subtotal use **current** prices |
| C5 | Stock drops below cart quantity | 200 with `inStock: false` and a warning |
| C6 | View a checked-out cart | 200, `CHECKED_OUT`, points to its `orderId` |

### `PUT /carts/{id}/items/{productId}`

| ID | Case | Expected |
|---|---|---|
| A1 | Add item | 200, line added |
| A2 | Put same product again | quantity **replaced**, not added |
| A3 | Quantity equal to stock | 200 |
| A4 | Quantity above stock | 409 `INSUFFICIENT_INVENTORY`, cart unchanged |
| A5 | Quantity 0, negative, decimal, string, missing, 100 | 400 `VALIDATION_ERROR` |
| A6 | Unexpected extra field | 400 `VALIDATION_ERROR` |
| A7 | Unknown product | 404 `PRODUCT_NOT_FOUND` |
| A8 | Unknown cart | 404 `CART_NOT_FOUND` |
| A9 | Cart already checked out | 409 `CART_ALREADY_CHECKED_OUT` |
| A10 | Product with zero stock | 409 `INSUFFICIENT_INVENTORY` |
| A11 | JSON array / `null` / number instead of an object | 400 `VALIDATION_ERROR` or `INVALID_JSON` |
| A12 | 8 concurrent edits to one cart | all 200; one consistent line, subtotal matches |

### `DELETE /carts/{id}/items/{productId}`

| ID | Case | Expected |
|---|---|---|
| D1 | Remove item | 200, line gone, subtotal updated |
| D2 | Item not in cart | 404 `ITEM_NOT_IN_CART` |
| D3 | Unknown cart | 404 `CART_NOT_FOUND` |
| D4 | Cart already checked out | 409 `CART_ALREADY_CHECKED_OUT` |
| D5 | Remove the last item, then checkout | 422 `CART_EMPTY` |

### `POST /carts/{id}/checkout`

| ID | Case | Expected |
|---|---|---|
| K1 | Valid checkout | 201 order; stock reduced; cart `CHECKED_OUT` with `orderId` |
| K2 | Missing / 7-char / 101-char `Idempotency-Key` | 400 `IDEMPOTENCY_KEY_REQUIRED` |
| K3 | Empty cart | 422 `CART_EMPTY` |
| K4 | Unknown cart | 404 `CART_NOT_FOUND` |
| K5 | Stock dropped after adding to cart | 409 `INSUFFICIENT_INVENTORY` with per-line details |
| K6 | Cart already checked out, new key | 409 `CART_ALREADY_CHECKED_OUT` with the existing `orderId` |
| K7 | Unknown coupon | 404 `COUPON_NOT_FOUND`, nothing written |
| K8 | Coupon already redeemed | 409 `COUPON_ALREADY_REDEEMED` |
| K9 | Coupon in lower case / with spaces | accepted (codes are normalised) |
| K10 | Empty `couponCode` or extra body field | 400 `VALIDATION_ERROR` |
| K11 | Payment declined | 402 `PAYMENT_DECLINED`; I5 holds |
| K12 | Retry with same key after success | same order, `Idempotent-Replayed: true`, no second stock decrement |
| K13 | Same key sent concurrently | one 201, one 409 `REQUEST_IN_PROGRESS` |
| K14 | Same key, different cart or coupon | 422 `IDEMPOTENCY_KEY_REUSED` |
| K15 | Same key after a failed attempt (cart fixed) | 201 (failure freed the key) |
| K16 | 8 carts race for 3 units | exactly 3 orders; stock 0 |
| K17 | Same cart, two keys, concurrently | one order; other 409 `CART_ALREADY_CHECKED_OUT` |
| K18 | Same coupon, two carts, concurrently | one discounted order; other 409 `COUPON_ALREADY_REDEEMED` |
| K19 | Discount rounding through the API | $10.05 at 10% → $1.01 off |
| K20 | 100% coupon | total 0, never negative |
| K21 | Cart edits while its checkout waits on payment | edit waits for the lock, then gets 409 `CART_ALREADY_CHECKED_OUT`; order matches the cart at checkout |
| K22 | `couponCode` is a number | 400 `VALIDATION_ERROR` |
| K23 | Two `Idempotency-Key` headers (Node joins them with a comma) | 400 `IDEMPOTENCY_KEY_REQUIRED`, not merged into one key |
| K24 | Admin stock change sent while a checkout waits on payment | the change waits for the product lock and applies after the commit |

### `GET /orders/{id}`

| ID | Case | Expected |
|---|---|---|
| O1 | Existing order | 200 with line snapshot, subtotal, discount, total, coupon, payment reference |
| O2 | Unknown order | 404 `ORDER_NOT_FOUND` |
| O3 | Product price changed after the order | order unchanged (I8) |

### `GET /coupons/{code}`

| ID | Case | Expected |
|---|---|---|
| Q1 | Available coupon | 200 `AVAILABLE` |
| Q2 | After redemption | 200 `REDEEMED` |
| Q3 | Lower-case code | found |
| Q4 | Unknown code | 404 `COUPON_NOT_FOUND` |

### `POST /admin/coupons`, `GET /admin/coupons`

| ID | Case | Expected |
|---|---|---|
| M1 | No orders yet | 409 `NO_ELIGIBLE_MILESTONE`, `nextMilestoneAtOrder: 2` |
| M2 | Milestone reached | 201, milestone 1, `unlockedAtOrderCount: 2`, `percentOff: 10` |
| M3 | Milestone already rewarded | 409 |
| M4 | Two milestones waiting (4 orders) | two calls succeed (milestones 1 and 2), third 409 |
| M5 | 5 concurrent generate calls, one milestone | exactly one coupon |
| M6 | Orders that used a coupon | still count toward milestones |
| M7 | Failed checkouts | do not count toward milestones |
| M8 | List | 200, all coupons with status |

### `GET /admin/report`

| ID | Case | Expected |
|---|---|---|
| R1 | Empty store | all zeros |
| R2 | After mixed orders with a coupon | quantity per product, gross, discount, net all correct; net = Σ order totals |
| R3 | Failed checkouts | not counted |
| R4 | Called twice | identical response; no state change |

### `PATCH /admin/products/{id}`

| ID | Case | Expected |
|---|---|---|
| U1 | Change price / stock | 200, product updated, open carts show the new price |
| U2 | Empty body | 400 `VALIDATION_ERROR` |
| U3 | Negative, decimal or string values; unknown field | 400 `VALIDATION_ERROR` |
| U4 | Unknown product | 404 `PRODUCT_NOT_FOUND` |

### Invariant soak test

| ID | Case | Expected |
|---|---|---|
| S1 | 60 random concurrent operations (add, checkout, retry, coupon use, admin generate) with a fixed seed | I1, I2, I3, I4, I6, I7, I9 all hold at the end |

## Manual UI checks (frontend)

1. Add products, change quantities, remove an item: totals update.
2. Checkout without a coupon: receipt shows lines and total; stock badge drops.
3. "Send the same checkout again": banner says the same order was replayed.
4. Admin: after n orders, generate a coupon; generating again shows `NO_ELIGIBLE_MILESTONE`.
5. Use the coupon at checkout: receipt shows the discount; coupon becomes redeemed.
6. Change a price in Catalog: the open cart shows the new price.
7. "Race for the last units": only as many checkouts as there is stock succeed.

## Out of scope

Authentication, persistence across restarts, multiple instances, load testing.
