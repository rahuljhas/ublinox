# Checkout & Rewards Service

Backend for a small store: carts, checkout that is safe to retry, inventory that never oversells, and a discount coupon unlocked by every n-th placed order. A small React frontend demonstrates the behaviour.

- `backend/`: Node.js + TypeScript + Express. All state is in memory, seeded from `backend/src/data/products.json`. No database.
- `frontend/`: Vite + React + TypeScript. Shop, cart, checkout with coupon, receipt, and an admin panel.
- `docs/checkout-sequence.png`: sequence diagram of the checkout flow.
- `task.md`: the assignment brief.
- `docs/EDGE_CASES.md`: every edge case, what each customer sees, and its test.
- `docs/ERRORS.md`: every error code, when it happens, and what the client should do.
- `docs/TEST_PLAN.md`, `docs/REQUIREMENTS.md`, `docs/index.html`: test plan, requirements checklist, and an HTML spec page.

## Run it

Requires Node.js 20 or later.

```bash
# terminal 1: API on http://localhost:3000
cd backend
npm install
npm start

# terminal 2: UI on http://localhost:5173 (proxies /api to the backend)
cd frontend
npm install
npm run dev
```

Run the backend tests (111 automated tests), and the live edge-case run against a started server (37 checks):

```bash
cd backend
npm test
npm run edge-cases   # needs the server running
```

Configuration (environment variables for the backend):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `COUPON_EVERY_N_ORDERS` | `5` | n: every n-th placed order unlocks one coupon |
| `COUPON_PERCENT_OFF` | `10` | x: coupon discount in whole percent (1–100) |
| `PAYMENT_DELAY_MS` | `150` | Delay of the fake payment provider |

Data resets on every restart (in-memory store).

## API

All bodies are JSON. Money is always an integer number of cents (`priceCents`, `totalCents`, …). Full error catalogue: `docs/ERRORS.md`.

### Errors

Every error has the same shape, and `code` is stable for clients to branch on:

```json
{ "error": { "code": "INSUFFICIENT_INVENTORY", "message": "Not enough stock for one or more items.", "details": { "lines": [{ "productId": "p-print", "requested": 2, "available": 1 }] } } }
```

### Customer endpoints

| Method & path | Body | Success | Important errors |
|---|---|---|---|
| `GET /products` | – | 200 list of products | – |
| `POST /carts` | – | 201 cart | – |
| `GET /carts/{cartId}` | – | 200 cart with current prices, line totals, subtotal, stock warnings | 404 `CART_NOT_FOUND` |
| `PUT /carts/{cartId}/items/{productId}` | `{ "quantity": 1-99 }` | 200 cart (adds the item or sets its quantity) | 400 `VALIDATION_ERROR`, 404 `PRODUCT_NOT_FOUND`, 409 `INSUFFICIENT_INVENTORY`, 409 `CART_ALREADY_CHECKED_OUT` |
| `DELETE /carts/{cartId}/items/{productId}` | – | 200 cart | 404 `ITEM_NOT_IN_CART`, 409 `CART_ALREADY_CHECKED_OUT` |
| `POST /carts/{cartId}/checkout` | `{ "couponCode"?: string, "expectedSubtotalCents"?: int }` + header `Idempotency-Key` (8–100 chars) | 201 order. A retry with the same key returns the same order with header `Idempotent-Replayed: true` | 400 `IDEMPOTENCY_KEY_REQUIRED`, 402 `PAYMENT_DECLINED`, 404 `COUPON_NOT_FOUND`, 409 `INSUFFICIENT_INVENTORY`, 409 `CART_ALREADY_CHECKED_OUT`, 409 `COUPON_ALREADY_REDEEMED`, 409 `PRICE_CHANGED`, 409 `REQUEST_IN_PROGRESS`, 422 `CART_EMPTY`, 422 `IDEMPOTENCY_KEY_REUSED` |
| `GET /orders/{orderId}` | – | 200 order with line snapshot (name, unit price, quantity), subtotal, discount, total, coupon | 404 `ORDER_NOT_FOUND` |
| `GET /coupons/{code}` | – | 200 `{ code, percentOff, status }` | 404 `COUPON_NOT_FOUND` |

### Admin endpoints (no auth; administrative by the `/admin` prefix)

| Method & path | Body | Success | Important errors |
|---|---|---|---|
| `POST /admin/coupons` | – | 201 coupon for the earliest unrewarded milestone | 409 `NO_ELIGIBLE_MILESTONE` (details include `nextMilestoneAtOrder`) |
| `GET /admin/coupons` | – | 200 all coupons with status | – |
| `GET /admin/orders?limit=&offset=` | – | 200 `{ orders, total, limit, offset }`, newest first (`limit` 1–100, default 20) | 400 `VALIDATION_ERROR` |
| `GET /admin/report` | – | 200 orders placed, quantity sold per product, gross revenue, discounts, net revenue, coupons generated / available / redeemed | – |
| `PATCH /admin/products/{productId}` | `{ "priceCents"?: int, "inventory"?: int }` | 200 product | 400 `VALIDATION_ERROR`, 404 `PRODUCT_NOT_FOUND` |

### Example

```bash
CART=$(curl -s -X POST localhost:3000/carts | jq -r .id)
curl -s -X PUT localhost:3000/carts/$CART/items/p-lamp -H 'Content-Type: application/json' -d '{"quantity":2}'
curl -s -X POST localhost:3000/carts/$CART/checkout -H 'Idempotency-Key: 3f1c9a7e-demo' -H 'Content-Type: application/json' -d '{}'
# Sending the same request again returns the same order (Idempotent-Replayed: true)
```

## Design summary

The full reasoning will live in `DECISIONS.md`. In short:

- **Checkout** claims the `Idempotency-Key`, locks the cart, then the coupon and products in sorted order, validates stock and coupon, awaits the fake payment, and then commits every write in one synchronous block. Any failure before the commit writes nothing and frees the key.
- **Locks** are an in-process keyed mutex. They matter only around the payment `await`; code without an `await` cannot interleave in Node.
- **Prices**: a cart always shows current prices; an order stores the prices charged at checkout.
- **Coupons**: milestone k is reached at k × n placed orders; each milestone yields at most one coupon; the discount is rounded half up and never exceeds the subtotal.
- **One instance only**: state is in process memory, so running two instances would split stock and coupons.
