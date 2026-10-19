# Edge Cases

How the service behaves in each edge case from the assignment, what every customer sees, where the rule is enforced, and the test that proves it.

- Tests: `backend/test/edgeCases.test.ts` (E1–E10). Other IDs (K, X, H) refer to `docs/TEST_PLAN.md`.
- Run: `cd backend && npx vitest run test/edgeCases.test.ts`
- Test product: **Limited Print**, $75.00, **3 in stock** (set to 1 where a case needs a single unit).

## Summary

| # | Edge case | Result | Test |
|---|---|---|---|
| 1 | Two consecutive orders, one unit left | First: order `CONFIRMED`. Second: `409 INSUFFICIENT_INVENTORY`, cart stays `OPEN` | E1 |
| 2 | Customer clicks "Place order" twice | One order, one charge | E2 |
| 3 | Clicking "Add" 2–3 times on one product | Each deliberate click counts; a duplicated request does not | E3 |
| 4 | 3–4 customers order the last unit, one succeeds | Only the winner is charged, so no refund is needed | E4 |
| 5 | 3 in stock: customer 1 buys 1, customer 2 asks for 3 | Customer 2 is told exactly 2 are left, then can buy 2 | E5, E5b |
| 6 | Stock and payment never negative | Stock stops at 0; charges are ≥ 0; admin cannot set negatives | E6, S1 |
| 7 | Admin changes a price while the customer's page is open | Checkout stops with `409 PRICE_CHANGED`; the page shows the new price | E7, E8, E9 |
| 8 | More cases worth knowing | See below | E10, X9, X13, K12 |

---

## 1. Two consecutive orders on the same product

**Setup:** 1 unit left. Customer A checks out, then customer B.

| Step | Customer A | Customer B |
|---|---|---|
| Checkout | `201 Created`, order `status: CONFIRMED` | `409 INSUFFICIENT_INVENTORY` (`requested: 1, available: 0`) |
| `GET /carts/{id}` | `CHECKED_OUT`, `orderId` = A's order | `OPEN`, `orderId: null` (can edit and retry) |
| `GET /orders/{id}` | Full order: lines, unit price, subtotal, discount, total | – (no order exists) |
| `GET /admin/orders` | Listed | Not listed |
| Stock | 1 → 0 | unchanged (0) |

**Order and cart statuses**

| Object | Statuses | Transition |
|---|---|---|
| Cart | `OPEN` → `CHECKED_OUT` | Once, only when checkout commits. A checked-out cart cannot be edited (409). |
| Order | `CONFIRMED` | Created only after payment is approved and the commit succeeds, so it never exists in a pending or failed state. Shipping, cancellation and refunds are out of scope. |

**Enforced in:** `checkoutService.ts` (stock re-checked under the product lock). **Test:** E1.

## 2. Customer clicks "Place order" twice

| Click pattern | What the server sees | Result |
|---|---|---|
| Two clicks, same `Idempotency-Key` (what the UI sends), at the same time | Second request finds the key `IN_PROGRESS` | First `201`, second `409 REQUEST_IN_PROGRESS` |
| Second click after the first finished | Key `COMPLETED` | Same order returned again, header `Idempotent-Replayed: true` |
| Client generates a new key per click | Different key, same cart | `409 CART_ALREADY_CHECKED_OUT` with the existing `orderId` |

In every pattern: **one order and one approved charge**. The UI also disables the Checkout button while a request is running.

**Enforced in:** idempotency check at the top of `checkout()`, cart lock and the cart status check. **Tests:** E2, K12, K13, K17.

## 3. Clicking "Add" 2–3 times on the same product

`PUT /carts/{id}/items/{productId}` **sets** the quantity; it does not add to it.

| Situation | Result |
|---|---|
| Three deliberate clicks (quantity 1, then 2, then 3) | Quantity 3 |
| A 4th click when only 3 are in stock | `409 INSUFFICIENT_INVENTORY`; quantity stays 3 |
| The same request sent twice (network retry) | Quantity set to the same value twice, not doubled |
| Two clicks fired before the first response returns | The UI disables "Add" until the cart update returns, so every click counts |

**Why set instead of add:** a retried "add 1" request would add twice. A retried "set to 2" is harmless.

**Enforced in:** `cartService.setItemQuantity`, `App.tsx` (`cartBusy`). **Tests:** E3, X12, A2.

## 4. Several customers order the last unit; refund for the losers?

**Setup:** 1 unit left, 4 customers check out at the same moment.

| Customer | Reaches payment? | Result | Charged |
|---|---|---|---|
| First to get the product lock | Yes | `201`, order `CONFIRMED` | $75.00 |
| The other three | **No** | `409 INSUFFICIENT_INVENTORY` | Nothing |

**No refund is ever needed**, because stock is checked *before* payment while holding the product lock. Losers are refused before the payment step. After payment is approved the commit is synchronous and cannot fail, so a charge without an order cannot happen.

If the winner's payment is declined, the next customer in line gets the unit (X9).

**Enforced in:** order of steps in `checkoutService.ts`: validate → pay → commit. **Tests:** E4 (the payment log shows exactly one charge), X3, X9.

## 5. 3 in stock: customer 1 buys 1, customer 2 asks for 3

**One after the other**

| Step | Customer 1 | Customer 2 |
|---|---|---|
| Checkout | `201`, buys 1 (stock 3 → 2) | `409 INSUFFICIENT_INVENTORY` |
| Error details | – | `{ productId: "p-last", requested: 3, available: 2 }` |
| Next | – | Lowers quantity to 2 and retries with the **same key** → `201` |
| Charged | $75.00 | Nothing on the refused attempt, then $150.00 |

**At the same moment:** whoever gets the lock first is served. Either customer 1 wins (1 sold, customer 2 told 2 are left) or customer 2 wins (3 sold, customer 1 told 0 are left). Stock always ends at `3 − sold`.

The error says per product how many were requested and how many are available, so the client can show "Only 2 left".

**Tests:** E5, E5b, X4, X7.

## 6. Stock and payment are never negative

| Guard | How | Test |
|---|---|---|
| Stock cannot go below 0 by selling | Checked under the product lock before every commit | E6, X3, S1 |
| Admin cannot set negative stock or price | `PATCH /admin/products` rejects `< 0` with `400 VALIDATION_ERROR` | E6, U3 |
| Total cannot go below 0 | Discount is capped at the subtotal; 100% coupon gives `totalCents: 0` | E6, K20 |
| Charge amount ≥ 0 | Every recorded payment charge has `amountCents ≥ 0` | E6 |
| Money is exact | Integer cents only; discount rounded half up once | money tests, K19 |

## 7. Admin changes a price while the customer's page is open

**Setup:** cart shows 2 × Mug = $29.00. The admin raises the Mug to $16.00. The customer clicks Checkout on the old page.

| Step | What happens |
|---|---|
| 1 | The page sends `expectedSubtotalCents: 2900` (the subtotal it is showing) |
| 2 | The server prices the cart at current prices: $32.00 |
| 3 | They differ → `409 PRICE_CHANGED` with `expectedSubtotalCents`, `currentSubtotalCents` and each line's current unit price. **Nothing is charged or reserved.** |
| 4 | The page reloads the cart (new price shown) and shows "Prices changed since you opened the page" |
| 5 | The customer checks out again, same key, `expectedSubtotalCents: 3200` → `201` |

| Variant | Result | Test |
|---|---|---|
| Price went **up** | `409 PRICE_CHANGED` | E7 |
| Price went **down** | Also `409 PRICE_CHANGED`: never charge an amount the customer did not see | E9 |
| Client does not send `expectedSubtotalCents` (API clients) | Charged the current price | E8 |
| Price change arrives while a checkout is already paying | The change waits for the product lock; that order pays the price it validated | X11 |
| Customer returns to the tab | The page reloads prices and the cart on focus | UI |

**Enforced in:** `checkoutService.ts` (subtotal comparison under the lock), `CartPanel.tsx` (sends the subtotal, handles `PRICE_CHANGED`).

## 8. More edge cases

| Case | Result | Test |
|---|---|---|
| Last unit and the only coupon contested together | One winner gets both; the coupon points to that order | X13 |
| Winner's payment declined | Nothing written; the next customer gets the unit | X9 |
| Response lost after a successful order | Retry with the same key returns the same order | K12 |
| Same key reused for a different cart or coupon | `422 IDEMPOTENCY_KEY_REUSED` | K14 |
| Product sells out while in other carts | Those carts show `inStock: false`; checkout 409 | X14 |
| Two carts list the same products in opposite order | No deadlock (locks taken in sorted order) | X5 |
| Admin restocks during a race | Never more sales than units | X10 |
| Invalid `expectedSubtotalCents` (negative, decimal, text) | `400 VALIDATION_ERROR` | E10 |
| A slow checkout holds a product and the line gets long | After `LOCK_WAIT_MS` (10 s) a waiting shopper gets `503 SERVER_BUSY` + `Retry-After: 2`, is never charged, and can retry with the same key | T1–T3, L2 |
| The payment provider never answers | `504 PAYMENT_TIMEOUT` after `PAYMENT_TIMEOUT_MS` (15 s); nothing written; locks and key released; another shopper can buy | T4, T5 |
| A retry arrives after the key's 24 h memory expired | Cannot duplicate: the cart is already `CHECKED_OUT`, so `409 CART_ALREADY_CHECKED_OUT` with the existing `orderId` | T6 |
| 100+ shoppers check out at once | No 5xx; stock, money and orders add up; limited product sells exactly its units | L1, `npm run load` |
| Server restarts | All data, including idempotency keys, is lost (in-memory store). A retry after a restart would be treated as new. Production needs a database. | – (documented limitation) |

---

## Order history

| Who | Endpoint | Returns |
|---|---|---|
| Admin | `GET /admin/orders?limit=20&offset=0` | `{ orders, total, limit, offset }`, newest first. Each order: `id`, `status`, `cartId`, `createdAt`, `itemCount`, `subtotalCents`, `discountCents`, `totalCents`, `couponCode` |
| Customer | `GET /orders/{id}` | One full order with line snapshots |
| Customer | `GET /orders?customerId=u-ben` | That customer's orders with line items, newest first (`customerId` is required) |
| Customer UI | "Orders for <name>" section | The selected demo customer's orders from the server. Switching customer (Aisha, Ben, Chloe) swaps the cart and the history |

| Rule | Detail | Test |
|---|---|---|
| Only successful orders appear | Declined, refused and empty-cart checkouts never create an order | H4 |
| Replayed retries appear once | A replay returns the existing order; it does not add a row | H4 |
| Pagination | `limit` 1–100 (default 20), `offset` ≥ 0 (default 0); beyond the end returns an empty page | H3 |
| Invalid query | `limit=0`, `limit=101`, `limit=abc`, `offset=-1`, `offset=1.5`, unknown parameter → `400 VALIDATION_ERROR` | H5 |
| Matches the report | `total` = `ordersPlaced`; sum of `totalCents` = `netRevenueCents` | H6 |
| Read-only | Listing never changes state | H6 |
