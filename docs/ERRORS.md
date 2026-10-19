# Error Handling

Every error the API can return (24 codes), when it happens, what the client should do, and the test that covers it.

## Error format

Every error has the same shape. Clients branch on `code`, which is stable. `message` is for people and may change.

```json
{
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "Not enough stock for one or more items.",
    "details": { "lines": [{ "productId": "p-print", "requested": 3, "available": 2 }] }
  }
}
```

| Rule | Detail |
|---|---|
| No 500 for client mistakes | Bad JSON, oversized bodies and bad URLs return 4xx. 500 is only for real server bugs. |
| A failed write changes nothing | Any error during checkout happens before the commit, so stock, coupons, carts and orders are untouched. |
| Validation lists every problem | `VALIDATION_ERROR` returns `details.issues: [{ path, message }]` for each failing field. |

## Status codes used

| Status | Meaning here |
|---|---|
| 400 | The request itself is malformed or invalid. Fix the request. |
| 402 | Payment was declined. |
| 404 | The cart, product, order, coupon or route does not exist. |
| 409 | The request is valid but conflicts with current state (stock, cart status, coupon used, price changed, request in progress). Re-read state and decide. |
| 413 | Body larger than 16 KB. |
| 422 | Valid JSON, but the operation makes no sense (empty cart, idempotency key reused for another request). |
| 503 | The server is busy: the request waited too long in line for a cart, product or coupon. Retry the same request. |
| 504 | The payment provider did not answer in time. |
| 500 | Unexpected server error. |

## Error catalogue

| Code | HTTP | Endpoints | When | `details` | Client should | Tests |
|---|---|---|---|---|---|---|
| `VALIDATION_ERROR` | 400 | all with a body or query | Field missing, wrong type, out of range, or unknown field | `issues[]` | Fix the field named in `path` | A5, A6, A11, K10, K22, U2, U3, H5, E10 |
| `INVALID_JSON` | 400 | all with a body | Body is not valid JSON, or is `null` / a bare number | – | Send a JSON object | P3, A11 |
| `BAD_REQUEST` | 400 | all | Malformed URL encoding, e.g. `/carts/%E0%A4%A` | – | Encode the URL correctly | P8 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | checkout | Header missing, shorter than 8, longer than 100, characters outside `A-Z a-z 0-9 . _ : -`, or sent twice | – | Send one valid key | K2, K23 |
| `PAYMENT_DECLINED` | 402 | checkout | The payment provider declined | `reason` | Try another payment method; the same key may be reused | K11, X9 |
| `CART_NOT_FOUND` | 404 | carts, checkout | Cart id does not exist | `cartId` | Create a new cart | C3, A8, D3, K4 |
| `PRODUCT_NOT_FOUND` | 404 | add item, admin patch | Product id does not exist | `productId` | Refresh the catalog | A7, U4 |
| `ITEM_NOT_IN_CART` | 404 | remove item | Product is not in the cart | `productId` | Refresh the cart | D2 |
| `ORDER_NOT_FOUND` | 404 | get order | Order id does not exist | `orderId` | Check the id | O2 |
| `COUPON_NOT_FOUND` | 404 | checkout, coupon lookup | No coupon with that code (case-insensitive) | `code` | Check the code | K7, Q4 |
| `ROUTE_NOT_FOUND` | 404 | – | Unknown path or unsupported method | – | Check the API docs | P2, P7 |
| `INSUFFICIENT_INVENTORY` | 409 | add item, checkout | Requested quantity is more than current stock | `lines[]: { productId, requested, available }` | Lower the quantity to `available` or remove the item | A4, A10, K5, X3, X4, E1, E5 |
| `CART_ALREADY_CHECKED_OUT` | 409 | add/remove item, checkout | Cart already became an order | `cartId`, `orderId` | Show the existing order; start a new cart | A9, D4, K6, K17, E2 |
| `COUPON_ALREADY_REDEEMED` | 409 | checkout | Coupon was used by another order | `code` | Remove the coupon or use another | K8, K18 |
| `PRICE_CHANGED` | 409 | checkout | `expectedSubtotalCents` was sent and differs from the current subtotal | `expectedSubtotalCents`, `currentSubtotalCents`, `lines[]` | Reload the cart, show the new total, ask the customer to confirm | E7, E9 |
| `REQUEST_IN_PROGRESS` | 409 | checkout | A checkout with the same key is still running | – | Wait briefly and retry with the same key | K13, E2 |
| `NO_ELIGIBLE_MILESTONE` | 409 | admin generate coupon | No unrewarded milestone reached yet | `placedOrders`, `everyNOrders`, `nextMilestoneAtOrder` | Wait for more orders | M1, M3 |
| `PAYLOAD_TOO_LARGE` | 413 | all with a body | Body over 16 KB | – | Send a smaller body | P5 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | all with a body | Body encoding not supported by the JSON parser | – | Send `application/json` | – |
| `CART_EMPTY` | 422 | checkout | Cart has no items | `cartId` | Add items first | K3, D5 |
| `IDEMPOTENCY_KEY_REUSED` | 422 | checkout | Key already used for a different cart or coupon | – | Use a new key for a new request | K14 |
| `SERVER_BUSY` | 503 | cart edits, checkout, admin product edit | Waited longer than `LOCK_WAIT_MS` (default 10 s) for the cart, product or coupon because other requests hold it | `resource` (which lock) | Wait `Retry-After` (2 s), then retry with the **same** Idempotency-Key. Nothing was written | T1–T3, L2 |
| `PAYMENT_TIMEOUT` | 504 | checkout | The payment provider did not answer within `PAYMENT_TIMEOUT_MS` (default 15 s) | – | Check whether you were charged before paying again. Nothing was recorded here; the Idempotency-Key is forwarded to the provider so a real provider can dedupe a retry | T4, T5 |
| `INTERNAL_ERROR` | 500 | all | Unexpected server error (logged) | – | Retry later | – |

## Errors by endpoint

| Endpoint | Possible errors |
|---|---|
| `GET /products` | – |
| `POST /carts` | – |
| `GET /carts/{id}` | 404 `CART_NOT_FOUND` |
| `PUT /carts/{id}/items/{pid}` | 400 `VALIDATION_ERROR` / `INVALID_JSON`, 404 `CART_NOT_FOUND` / `PRODUCT_NOT_FOUND`, 409 `INSUFFICIENT_INVENTORY` / `CART_ALREADY_CHECKED_OUT`, 413, 503 `SERVER_BUSY` |
| `DELETE /carts/{id}/items/{pid}` | 404 `CART_NOT_FOUND` / `ITEM_NOT_IN_CART`, 409 `CART_ALREADY_CHECKED_OUT`, 503 `SERVER_BUSY` |
| `POST /carts/{id}/checkout` | 400 `IDEMPOTENCY_KEY_REQUIRED` / `VALIDATION_ERROR` / `INVALID_JSON`, 402 `PAYMENT_DECLINED`, 404 `CART_NOT_FOUND` / `COUPON_NOT_FOUND`, 409 `CART_ALREADY_CHECKED_OUT` / `INSUFFICIENT_INVENTORY` / `COUPON_ALREADY_REDEEMED` / `PRICE_CHANGED` / `REQUEST_IN_PROGRESS`, 422 `CART_EMPTY` / `IDEMPOTENCY_KEY_REUSED`, 503 `SERVER_BUSY`, 504 `PAYMENT_TIMEOUT` |
| `GET /orders/{id}` | 404 `ORDER_NOT_FOUND` |
| `GET /coupons/{code}` | 404 `COUPON_NOT_FOUND` |
| `POST /admin/coupons` | 409 `NO_ELIGIBLE_MILESTONE` |
| `GET /admin/coupons` | – |
| `GET /admin/orders` | 400 `VALIDATION_ERROR` (bad `limit` / `offset` / unknown parameter) |
| `GET /admin/report` | – |
| `PATCH /admin/products/{id}` | 400 `VALIDATION_ERROR`, 404 `PRODUCT_NOT_FOUND`, 503 `SERVER_BUSY` |

## Checkout: which error wins

Checkout checks in this order and returns the **first** failure. Nothing is written for any of them.

| Order | Check | Error |
|---|---|---|
| 1 | Idempotency-Key header valid | 400 `IDEMPOTENCY_KEY_REQUIRED` |
| 2 | Body valid | 400 `VALIDATION_ERROR` |
| 3 | Key used before? Different request / still running / done | 422 `IDEMPOTENCY_KEY_REUSED` / 409 `REQUEST_IN_PROGRESS` / replay the stored 201 |
| 4 | Cart exists | 404 `CART_NOT_FOUND` |
| 5 | Cart open (under cart lock) | 409 `CART_ALREADY_CHECKED_OUT` |
| 6 | Cart not empty | 422 `CART_EMPTY` |
| 7 | Enough stock for every line (under product locks) | 409 `INSUFFICIENT_INVENTORY` |
| 8 | Coupon exists | 404 `COUPON_NOT_FOUND` |
| 9 | Coupon available (under coupon lock) | 409 `COUPON_ALREADY_REDEEMED` |
| 10 | Subtotal matches `expectedSubtotalCents` (if sent) | 409 `PRICE_CHANGED` |
| 11 | Payment approved, within `PAYMENT_TIMEOUT_MS` | 402 `PAYMENT_DECLINED` / 504 `PAYMENT_TIMEOUT` |
| 12 | Commit | – (cannot fail: synchronous, everything already checked) |

Waiting for the cart, product and coupon locks (steps 5, 7, 8, 9) can also end in `503 SERVER_BUSY` when the line is too long. Nothing is written in that case either.

## Errors and the Idempotency-Key

| Outcome | What happens to the key | A retry with the same key |
|---|---|---|
| 201 success | Stored with the response | Returns the same order (`Idempotent-Replayed: true`) |
| Any 4xx, 503 or 504 at steps 4–11 | Freed | Is evaluated again from scratch (e.g. succeeds after the cart is fixed) |
| 409 `REQUEST_IN_PROGRESS` | Still held by the first request | Returns the stored order once the first finishes |
| 422 `IDEMPOTENCY_KEY_REUSED` | Belongs to the earlier request | Always 422 for a different request |

Freeing the key on failure lets a customer fix the cart and retry without generating a new key. Storing failures instead would replay the same error forever.

## Examples

```bash
B=http://localhost:3000

# 400 VALIDATION_ERROR: quantity must be a whole number 1-99
curl -s -X PUT $B/carts/$CART/items/p-mug -H 'Content-Type: application/json' -d '{"quantity":0}'

# 409 INSUFFICIENT_INVENTORY: more than in stock
curl -s -X PUT $B/carts/$CART/items/p-print -H 'Content-Type: application/json' -d '{"quantity":99}'

# 400 IDEMPOTENCY_KEY_REQUIRED: no key
curl -s -X POST $B/carts/$CART/checkout -H 'Content-Type: application/json' -d '{}'

# 409 PRICE_CHANGED: page showed a different subtotal
curl -s -X POST $B/carts/$CART/checkout -H 'Idempotency-Key: demo-price-1' \
  -H 'Content-Type: application/json' -d '{"expectedSubtotalCents": 1}'

# 400 VALIDATION_ERROR: bad pagination
curl -s "$B/admin/orders?limit=0"
```
