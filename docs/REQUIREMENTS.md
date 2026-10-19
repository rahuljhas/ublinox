# Requirements Checklist

Every requirement in `task.md`, where it is enforced, and the test that proves it. Test IDs refer to `docs/TEST_PLAN.md`.

✅ done · ⚠️ done, needs writing up in DECISIONS.md · ❌ missing

| # | Requirement | Status | Enforced in | Proved by |
|---|---|---|---|---|
| 1 | Products: id, name, price, stock; 5+ seeded, 1 limited | ✅ | `data/products.json` (6, print ×3) | G1 |
| 2 | Invalid product / quantity never enters a cart | ✅ | `http/app.ts`, `cartService.ts` | A4–A11 |
| 3 | Never sell more than stock | ✅ | `checkoutService.ts` (check under lock) | K5, K16, S1 |
| 4 | Cart: create, add, change, remove, view with totals | ✅ | `cartService.ts` | C1–C6, A1–A3, D1 |
| 5 | Cart checked out at most once | ✅ | `checkoutService.ts` | K6, K17 |
| 6 | Price / stock change before checkout | ✅ | cart shows live price; order charges price at checkout | C4, K5, O3 |
| 7 | Retry never creates a 2nd order or charges stock twice | ✅ | `checkoutService.ts` (Idempotency-Key) | K12, K13, K14 |
| 8 | Concurrent checkouts never oversell | ✅ | `keyedMutex.ts` + atomic commit | K16, S1 |
| 9 | Order explains its total after product changes | ✅ | `OrderLine` snapshot | O1, O3 |
| 10 | Money without float errors | ✅ | `domain/money.ts` (integer cents) | money tests, K19 |
| 11 | Distinct, useful errors | ✅ | `domain/errors.ts` (22 codes) | every 4xx test |
| 12 | Payment fake, choice explained | ✅ | `domain/payment.ts` | K11 |
| 13 | Coupons configured by n and x | ✅ | `context.ts` (env vars) | M2, K20 |
| 14 | Coupon only at reached, unrewarded milestone | ✅ | `couponService.ts` | M1–M5 |
| 15 | Coupon redeemed once, not lost on failure, not double-used | ✅ | `checkoutService.ts` | K8, K11, K18 |
| 16 | Discount deterministic, total never negative | ✅ | `domain/money.ts` | K19, K20 |
| 17 | Extra coupon semantics decided and recorded | ✅ | any customer, no expiry, % fixed at generation | M4, M6 |
| 18 | Report: 6 figures, reconciles, read-only | ✅ | `reportService.ts` | R1–R4 |
| 19 | API documented; admin operations identified | ✅ | `README.md`, `/admin/*` | – |
| 20 | In-memory store still safe under overlap | ✅ | `keyedMutex.ts` | 5 tests fail with locks off |
| 21 | Multi-instance / production DB explained | ✅ | `DECISIONS.md` §8 | – |
| 22 | Tests include competing or repeated operations | ✅ | 111 tests + 37 live checks | `npm test`, `npm run edge-cases` |
| 23 | **DECISIONS.md** (heavily weighted) | ✅ | `DECISIONS.md`: 10 sections, 12 decisions | – |
| 24 | Meaningful commit history | ✅ | 25+ commits | – |
| 25 | Approximate time spent stated | ❌ | – | – |

## Open issues

| Issue | Impact | Fix |
|---|---|---|
| Customer page reads `GET /admin/report` | Blurs customer / admin boundary | Add public `GET /rewards/progress` |
| Idempotency keys kept forever | Memory grows | Defer: expire after 24 h (document) |
| One instance only | Cannot scale out | Defer: PostgreSQL row locks + unique key constraint (document) |
| Old SQLite diagram files on disk | Confusing leftovers | Delete `docs/architecture.png`, `docs/diagram.py` |
