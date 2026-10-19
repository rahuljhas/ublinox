/**
 * Endpoint-by-endpoint edge cases. IDs match docs/TEST_PLAN.md.
 * Race, retry and report tests live in checkout.test.ts and coupons.test.ts.
 */
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("platform", () => {
  it("P1 health, P2 unknown route, P3 malformed JSON, P4 CORS preflight", async () => {
    const t = setup();
    expect((await t.api().get("/health").expect(200)).body).toEqual({ status: "ok" });
    expect((await t.api().get("/nope").expect(404)).body.error.code).toBe("ROUTE_NOT_FOUND");

    const cartId = (await t.api().post("/carts").expect(201)).body.id;
    const bad = await t.api().put(`/carts/${cartId}/items/p-mid`).set("Content-Type", "application/json").send('{"quantity": ').expect(400);
    expect(bad.body.error.code).toBe("INVALID_JSON");

    const preflight = await t.api().options(`/carts/${cartId}/checkout`).expect(204);
    expect(preflight.headers["access-control-allow-headers"]).toContain("Idempotency-Key");
  });
});

describe("GET /products", () => {
  it("G1 lists products with integer money, G2 stock drops after checkout", async () => {
    const t = setup();
    const products = (await t.api().get("/products").expect(200)).body;
    expect(products).toHaveLength(3);
    for (const p of products) {
      expect(Number.isInteger(p.priceCents)).toBe(true);
      expect(Number.isInteger(p.inventory)).toBe(true);
    }
    const cartId = await t.cartWith({ "p-mid": 4 });
    await t.checkout(cartId, "products-key-1").expect(201);
    const after = (await t.api().get("/products")).body.find((p: { id: string }) => p.id === "p-mid");
    expect(after.inventory).toBe(46);
  });
});

describe("carts", () => {
  it("C1 create, C2 unique ids, C3 unknown cart", async () => {
    const t = setup();
    const a = (await t.api().post("/carts").expect(201)).body;
    const b = (await t.api().post("/carts").expect(201)).body;
    expect(a).toMatchObject({ status: "OPEN", items: [], itemCount: 0, subtotalCents: 0, orderId: null });
    expect(a.id).not.toBe(b.id);
    expect((await t.api().get("/carts/does-not-exist").expect(404)).body.error.code).toBe("CART_NOT_FOUND");
  });

  it("C4 prices the cart with current prices, C5 warns when stock falls below the cart quantity", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 2, "p-last": 3 });
    let cart = (await t.api().get(`/carts/${cartId}`)).body;
    expect(cart.subtotalCents).toBe(2 * 1450 + 3 * 7500);

    await t.api().patch("/admin/products/p-mid").send({ priceCents: 1000 }).expect(200);
    await t.api().patch("/admin/products/p-last").send({ inventory: 1 }).expect(200);
    cart = (await t.api().get(`/carts/${cartId}`)).body;
    expect(cart.subtotalCents).toBe(2 * 1000 + 3 * 7500);
    expect(cart.items.find((i: { productId: string }) => i.productId === "p-last")).toMatchObject({ inStock: false, availableInventory: 1 });
    expect(cart.warnings).toHaveLength(1);
  });
});

describe("PUT /carts/{id}/items/{productId}", () => {
  it("A1 adds, A2 replaces quantity instead of adding, A3 allows exactly the stock", async () => {
    const t = setup();
    const cartId = (await t.api().post("/carts")).body.id;
    await t.api().put(`/carts/${cartId}/items/p-mid`).send({ quantity: 2 }).expect(200);
    const cart = (await t.api().put(`/carts/${cartId}/items/p-mid`).send({ quantity: 5 }).expect(200)).body;
    expect(cart.items).toEqual([expect.objectContaining({ productId: "p-mid", quantity: 5, lineTotalCents: 7250 })]);
    await t.api().put(`/carts/${cartId}/items/p-last`).send({ quantity: 3 }).expect(200);
  });

  it("A4 above stock is rejected and the cart is unchanged", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-last": 1 });
    const res = await t.api().put(`/carts/${cartId}/items/p-last`).send({ quantity: 4 }).expect(409);
    expect(res.body.error).toMatchObject({ code: "INSUFFICIENT_INVENTORY", details: { lines: [{ productId: "p-last", requested: 4, available: 3 }] } });
    expect((await t.api().get(`/carts/${cartId}`)).body.items[0].quantity).toBe(1);
  });

  it.each([
    ["zero", { quantity: 0 }],
    ["negative", { quantity: -1 }],
    ["decimal", { quantity: 1.5 }],
    ["string", { quantity: "2" }],
    ["missing", {}],
    ["above 99", { quantity: 100 }],
    ["extra field", { quantity: 1, priceCents: 1 }],
  ])("A5/A6 rejects %s quantity with VALIDATION_ERROR", async (_label, body) => {
    const t = setup();
    const cartId = (await t.api().post("/carts")).body.id;
    const res = await t.api().put(`/carts/${cartId}/items/p-mid`).send(body).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.issues.length).toBeGreaterThan(0);
  });

  it("A7 unknown product, A8 unknown cart, A9 checked-out cart, A10 zero stock", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    expect((await t.api().put(`/carts/${cartId}/items/ghost`).send({ quantity: 1 }).expect(404)).body.error.code).toBe("PRODUCT_NOT_FOUND");
    expect((await t.api().put(`/carts/ghost/items/p-mid`).send({ quantity: 1 }).expect(404)).body.error.code).toBe("CART_NOT_FOUND");

    await t.api().patch("/admin/products/p-cheap").send({ inventory: 0 }).expect(200);
    expect((await t.api().put(`/carts/${cartId}/items/p-cheap`).send({ quantity: 1 }).expect(409)).body.error.code).toBe("INSUFFICIENT_INVENTORY");

    const order = (await t.checkout(cartId, "after-checkout-key").expect(201)).body;
    const res = await t.api().put(`/carts/${cartId}/items/p-mid`).send({ quantity: 2 }).expect(409);
    expect(res.body.error).toMatchObject({ code: "CART_ALREADY_CHECKED_OUT", details: { orderId: order.id } });
  });
});

describe("DELETE /carts/{id}/items/{productId}", () => {
  it("D1 removes, D2 item not in cart, D3 unknown cart, D4 checked-out cart", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1, "p-cheap": 2 });
    const cart = (await t.api().delete(`/carts/${cartId}/items/p-mid`).expect(200)).body;
    expect(cart.items.map((i: { productId: string }) => i.productId)).toEqual(["p-cheap"]);
    expect(cart.subtotalCents).toBe(398);

    expect((await t.api().delete(`/carts/${cartId}/items/p-mid`).expect(404)).body.error.code).toBe("ITEM_NOT_IN_CART");
    expect((await t.api().delete(`/carts/ghost/items/p-mid`).expect(404)).body.error.code).toBe("CART_NOT_FOUND");

    await t.checkout(cartId, "delete-after-key").expect(201);
    expect((await t.api().delete(`/carts/${cartId}/items/p-cheap`).expect(409)).body.error.code).toBe("CART_ALREADY_CHECKED_OUT");
  });
});

describe("POST /carts/{id}/checkout", () => {
  it("K1 creates the order, reduces stock and closes the cart", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 2, "p-cheap": 1 });
    const order = (await t.checkout(cartId, "happy-path-key").expect(201)).body;
    expect(order).toMatchObject({ cartId, subtotalCents: 3099, discountCents: 0, totalCents: 3099, coupon: null });
    expect(order.payment.reference).toMatch(/^fake_/);
    expect((await t.api().get(`/carts/${cartId}`)).body).toMatchObject({ status: "CHECKED_OUT", orderId: order.id });
    expect(t.ctx.store.products.get("p-mid")!.inventory).toBe(48);
  });

  it.each([
    ["missing", undefined],
    ["7 characters", "abcdefg"],
    ["101 characters", "k".repeat(101)],
  ])("K2 rejects an Idempotency-Key that is %s", async (_label, key) => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    const req = t.api().post(`/carts/${cartId}/checkout`);
    if (key) req.set("Idempotency-Key", key);
    expect((await req.send({}).expect(400)).body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(t.ctx.store.orders.size).toBe(0);
  });

  it("K3 empty cart, K4 unknown cart", async () => {
    const t = setup();
    const empty = (await t.api().post("/carts")).body.id;
    expect((await t.checkout(empty, "empty-cart-key1").expect(422)).body.error.code).toBe("CART_EMPTY");
    expect((await t.checkout("ghost-cart", "ghost-cart-key1").expect(404)).body.error.code).toBe("CART_NOT_FOUND");
  });

  it("K5 rejects when stock dropped after adding, with per-line details", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-last": 3, "p-mid": 1 });
    await t.api().patch("/admin/products/p-last").send({ inventory: 2 }).expect(200);
    const res = await t.checkout(cartId, "stock-drop-key").expect(409);
    expect(res.body.error).toMatchObject({
      code: "INSUFFICIENT_INVENTORY",
      details: { lines: [{ productId: "p-last", requested: 3, available: 2 }] },
    });
    expect(t.ctx.store.products.get("p-mid")!.inventory).toBe(50);
  });

  it("K6 a second checkout of the same cart with a new key returns the existing order id", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    const order = (await t.checkout(cartId, "first-key-0001").expect(201)).body;
    const res = await t.checkout(cartId, "second-key-002").expect(409);
    expect(res.body.error).toMatchObject({ code: "CART_ALREADY_CHECKED_OUT", details: { orderId: order.id } });
  });

  it("K8 redeemed coupon, K9 lower case and padded coupon codes are accepted", async () => {
    const t = setup();
    await t.placeOrders(2);
    const { code } = (await t.api().post("/admin/coupons").expect(201)).body;

    const cartA = await t.cartWith({ "p-mid": 1 });
    const used = (await t.checkout(cartA, "lowercase-key-1", `  ${code.toLowerCase()} `).expect(201)).body;
    expect(used.coupon).toEqual({ code, percentOff: 10 });

    const cartB = await t.cartWith({ "p-mid": 1 });
    expect((await t.checkout(cartB, "redeemed-key-01", code).expect(409)).body.error.code).toBe("COUPON_ALREADY_REDEEMED");
  });

  it("K10 rejects an empty coupon code and unexpected body fields", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    const empty = await t.api().post(`/carts/${cartId}/checkout`).set("Idempotency-Key", "empty-coupon-1").send({ couponCode: "" });
    expect(empty.status).toBe(400);
    const extra = await t.api().post(`/carts/${cartId}/checkout`).set("Idempotency-Key", "extra-field-01").send({ totalCents: 1 });
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("K14 same key with a different coupon is a different request", async () => {
    const t = setup();
    await t.placeOrders(2);
    const { code } = (await t.api().post("/admin/coupons").expect(201)).body;
    const cartId = await t.cartWith({ "p-mid": 1 });
    await t.checkout(cartId, "fingerprint-key").expect(201);
    expect((await t.checkout(cartId, "fingerprint-key", code).expect(422)).body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("K15 a failed attempt frees the key: fix the cart and retry with the same key", async () => {
    const t = setup();
    const cartId = (await t.api().post("/carts")).body.id;
    await t.checkout(cartId, "fix-and-retry-1").expect(422);
    await t.api().put(`/carts/${cartId}/items/p-mid`).send({ quantity: 1 }).expect(200);
    const res = await t.checkout(cartId, "fix-and-retry-1").expect(201);
    expect(res.headers["idempotent-replayed"]).toBe("false");
  });

  it("K19 rounds the discount half up through the API", async () => {
    const t = setup();
    await t.placeOrders(2);
    const { code } = (await t.api().post("/admin/coupons").expect(201)).body;
    await t.api().patch("/admin/products/p-mid").send({ priceCents: 1005 }).expect(200);
    const cartId = await t.cartWith({ "p-mid": 1 });
    const order = (await t.checkout(cartId, "rounding-key-1", code).expect(201)).body;
    expect(order).toMatchObject({ subtotalCents: 1005, discountCents: 101, totalCents: 904 });
  });

  it("K20 a 100% coupon makes the total zero, never negative", async () => {
    const t = setup({ config: { couponPercentOff: 100 } });
    await t.placeOrders(2);
    const { code } = (await t.api().post("/admin/coupons").expect(201)).body;
    const cartId = await t.cartWith({ "p-last": 1 });
    const order = (await t.checkout(cartId, "free-order-key", code).expect(201)).body;
    expect(order).toMatchObject({ subtotalCents: 7500, discountCents: 7500, totalCents: 0 });
  });

  it("K21 a cart edit sent during checkout waits for the lock and then sees the cart closed", async () => {
    const t = setup({ paymentDelayMs: 60 });
    const cartId = await t.cartWith({ "p-mid": 1 });
    const checkoutReq = t.checkout(cartId, "edit-during-key");
    await new Promise((r) => setTimeout(r, 15)); // checkout is now waiting on payment while holding the cart lock
    const editReq = t.api().put(`/carts/${cartId}/items/p-mid`).send({ quantity: 9 });

    const [order, edit] = await Promise.all([checkoutReq, editReq]);
    expect(order.status).toBe(201);
    expect(order.body.lines[0].quantity).toBe(1);
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("CART_ALREADY_CHECKED_OUT");
  });
});

describe("GET /orders/{id}", () => {
  it("O1 returns the full order, O2 unknown order", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-cheap": 3 });
    const placed = (await t.checkout(cartId, "order-fetch-key").expect(201)).body;
    const fetched = (await t.api().get(`/orders/${placed.id}`).expect(200)).body;
    expect(fetched).toEqual(placed);
    expect(fetched.lines).toEqual([{ productId: "p-cheap", name: "Sticker", unitPriceCents: 199, quantity: 3, lineTotalCents: 597 }]);
    expect((await t.api().get("/orders/ghost").expect(404)).body.error.code).toBe("ORDER_NOT_FOUND");
  });
});

describe("GET /coupons/{code}", () => {
  it("Q1 available, Q2 redeemed after use, Q3 case-insensitive, Q4 unknown", async () => {
    const t = setup();
    await t.placeOrders(2);
    const { code } = (await t.api().post("/admin/coupons").expect(201)).body;

    expect((await t.api().get(`/coupons/${code}`).expect(200)).body).toEqual({ code, percentOff: 10, status: "AVAILABLE" });
    expect((await t.api().get(`/coupons/${code.toLowerCase()}`).expect(200)).body.code).toBe(code);

    const cartId = await t.cartWith({ "p-mid": 1 });
    await t.checkout(cartId, "coupon-status-key", code).expect(201);
    expect((await t.api().get(`/coupons/${code}`).expect(200)).body.status).toBe("REDEEMED");
    expect((await t.api().get("/coupons/NOPE-000").expect(404)).body.error.code).toBe("COUPON_NOT_FOUND");
  });
});

describe("admin coupons", () => {
  it("M1 no orders yet, M4 two waiting milestones are rewarded one per call, M8 list", async () => {
    const t = setup();
    expect((await t.api().get("/admin/coupons").expect(200)).body).toEqual([]);
    const early = await t.api().post("/admin/coupons").expect(409);
    expect(early.body.error.details).toMatchObject({ placedOrders: 0, everyNOrders: 2, nextMilestoneAtOrder: 2 });

    await t.placeOrders(4);
    const first = (await t.api().post("/admin/coupons").expect(201)).body;
    const second = (await t.api().post("/admin/coupons").expect(201)).body;
    await t.api().post("/admin/coupons").expect(409);
    expect([first.milestone, second.milestone]).toEqual([1, 2]);
    expect(first.code).not.toBe(second.code);

    const list = (await t.api().get("/admin/coupons").expect(200)).body;
    expect(list.map((c: { status: string }) => c.status)).toEqual(["AVAILABLE", "AVAILABLE"]);
  });

  it("M6 orders that used a coupon count toward milestones, M7 failed checkouts do not", async () => {
    const t = setup();
    await t.placeOrders(2);
    const { code } = (await t.api().post("/admin/coupons").expect(201)).body;

    const failing = await t.cartWith({ "p-mid": 1 });
    t.payment.declineNext = 1;
    await t.checkout(failing, "declined-key-01").expect(402);
    expect(t.ctx.store.placedOrders).toBe(2);
    await t.api().post("/admin/coupons").expect(409);

    const withCoupon = await t.cartWith({ "p-mid": 1 });
    await t.checkout(withCoupon, "with-coupon-key", code).expect(201);
    await t.placeOrders(1);
    expect((await t.api().post("/admin/coupons").expect(201)).body.milestone).toBe(2);
  });
});

describe("GET /admin/report", () => {
  it("R1 starts at zero, R3 ignores failed checkouts", async () => {
    const t = setup();
    expect((await t.api().get("/admin/report").expect(200)).body).toMatchObject({
      ordersPlaced: 0,
      productsSold: [],
      grossRevenueCents: 0,
      totalDiscountCents: 0,
      netRevenueCents: 0,
      coupons: { generated: 0, available: 0, redeemed: 0 },
    });

    const cartId = await t.cartWith({ "p-mid": 1 });
    t.payment.declineNext = 1;
    await t.checkout(cartId, "report-fail-key").expect(402);
    await t.checkout("ghost", "report-ghost-key").expect(404);
    expect((await t.api().get("/admin/report")).body.ordersPlaced).toBe(0);
  });
});

describe("PATCH /admin/products/{id}", () => {
  it("U1 updates price and stock", async () => {
    const t = setup();
    const res = await t.api().patch("/admin/products/p-mid").send({ priceCents: 1999, inventory: 7 }).expect(200);
    expect(res.body).toMatchObject({ id: "p-mid", priceCents: 1999, inventory: 7 });
  });

  it.each([
    ["empty body", {}],
    ["negative price", { priceCents: -1 }],
    ["decimal price", { priceCents: 12.5 }],
    ["string stock", { inventory: "5" }],
    ["unknown field", { name: "Renamed" }],
  ])("U2/U3 rejects %s", async (_label, body) => {
    const t = setup();
    expect((await t.api().patch("/admin/products/p-mid").send(body).expect(400)).body.error.code).toBe("VALIDATION_ERROR");
    expect(t.ctx.store.products.get("p-mid")).toMatchObject({ priceCents: 1450, inventory: 50 });
  });

  it("U4 unknown product", async () => {
    const t = setup();
    expect((await t.api().patch("/admin/products/ghost").send({ inventory: 1 }).expect(404)).body.error.code).toBe("PRODUCT_NOT_FOUND");
  });
});

describe("robustness: malformed requests never cause a 500", () => {
  it("P5 body over 16 KB → 413 PAYLOAD_TOO_LARGE", async () => {
    const t = setup();
    const cartId = (await t.api().post("/carts")).body.id;
    const res = await t.api().put(`/carts/${cartId}/items/p-mid`).send({ quantity: 1, pad: "x".repeat(20_000) }).expect(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("P6 wrong content type is treated as an empty body → 400 VALIDATION_ERROR", async () => {
    const t = setup();
    const cartId = (await t.api().post("/carts")).body.id;
    const res = await t.api().put(`/carts/${cartId}/items/p-mid`).set("Content-Type", "text/plain").send('{"quantity":1}').expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("P7 unsupported method → 404 ROUTE_NOT_FOUND", async () => {
    const t = setup();
    const cartId = (await t.api().post("/carts")).body.id;
    expect((await t.api().patch(`/carts/${cartId}`).send({}).expect(404)).body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("P8 malformed URL encoding → 400 BAD_REQUEST", async () => {
    const t = setup();
    expect((await t.api().get("/carts/%E0%A4%A").expect(400)).body.error.code).toBe("BAD_REQUEST");
  });

  it.each([
    ["array", "[1]", 400, "VALIDATION_ERROR"],
    ["null", "null", 400, "INVALID_JSON"],
    ["number", "5", 400, "INVALID_JSON"],
  ])("A11 JSON %s instead of an object is rejected", async (_label, raw, status, code) => {
    const t = setup();
    const cartId = (await t.api().post("/carts")).body.id;
    const res = await t.api().put(`/carts/${cartId}/items/p-mid`).set("Content-Type", "application/json").send(raw).expect(status);
    expect(res.body.error.code).toBe(code);
  });

  it("K22 couponCode must be a string", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    const res = await t.api().post(`/carts/${cartId}/checkout`).set("Idempotency-Key", "coupon-type-key").send({ couponCode: 123 }).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("K23 two Idempotency-Key headers (joined with a comma) are rejected, not merged into one key", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    const res = await t.api().post(`/carts/${cartId}/checkout`).set("Idempotency-Key", "first-key-001, second-key-02") // what Node gives for two headers.send({}).expect(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(t.ctx.store.orders.size).toBe(0);
  });
});

describe("more state and concurrency edges", () => {
  it("C6 a checked-out cart can still be viewed and points to its order", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    const order = (await t.checkout(cartId, "view-after-key").expect(201)).body;
    expect((await t.api().get(`/carts/${cartId}`).expect(200)).body).toMatchObject({ status: "CHECKED_OUT", orderId: order.id });
  });

  it("A12 concurrent edits to one cart are applied one at a time; the cart stays consistent", async () => {
    const t = setup();
    const cartId = (await t.api().post("/carts")).body.id;
    const quantities = [1, 2, 3, 4, 5, 6, 7, 8];
    const results = await Promise.all(quantities.map((q) => t.api().put(`/carts/${cartId}/items/p-mid`).send({ quantity: q })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const cart = (await t.api().get(`/carts/${cartId}`)).body;
    expect(cart.items).toHaveLength(1);
    expect(quantities).toContain(cart.items[0].quantity);
    expect(cart.subtotalCents).toBe(cart.items[0].quantity * 1450);
  });

  it("K24 an admin stock change sent during a checkout waits for it, so stock is never double-counted", async () => {
    const t = setup({ paymentDelayMs: 60 });
    const cartId = await t.cartWith({ "p-last": 2 });
    const checkoutReq = t.checkout(cartId, "admin-race-key");
    await new Promise((r) => setTimeout(r, 15)); // checkout holds the product lock while awaiting payment
    const patchReq = t.api().patch("/admin/products/p-last").send({ inventory: 10 });

    const [order, patch] = await Promise.all([checkoutReq, patchReq]);
    expect(order.status).toBe(201);
    // The admin value is applied after the checkout committed (3 - 2 = 1, then set to 10), never in the middle.
    expect(patch.body.inventory).toBe(10);
    expect(t.ctx.store.products.get("p-last")!.inventory).toBe(10);
  });

  it("D5 removing the last item and checking out → 422 CART_EMPTY", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    await t.api().delete(`/carts/${cartId}/items/p-mid`).expect(200);
    expect((await t.checkout(cartId, "emptied-cart-key").expect(422)).body.error.code).toBe("CART_EMPTY");
  });
});
