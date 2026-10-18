import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("checkout under concurrency", () => {
  it("never oversells: 8 carts race for 3 units, exactly 3 orders succeed", async () => {
    const t = setup();
    const carts = await Promise.all(Array.from({ length: 8 }, () => t.cartWith({ "p-last": 1 })));

    const results = await Promise.all(carts.map((cartId, i) => t.checkout(cartId, `race-key-${i}`)));

    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 409)).toHaveLength(5);
    for (const r of results.filter((r) => r.status === 409)) expect(r.body.error.code).toBe("INSUFFICIENT_INVENTORY");
    expect(t.ctx.store.products.get("p-last")!.inventory).toBe(0);
    expect(t.ctx.store.orders.size).toBe(3);
  });

  it("checks out the same cart only once when two different requests race", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 2 });

    const [a, b] = await Promise.all([t.checkout(cartId, "same-cart-key-a"), t.checkout(cartId, "same-cart-key-b")]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error.code).toBe("CART_ALREADY_CHECKED_OUT");
    expect(t.ctx.store.products.get("p-mid")!.inventory).toBe(48);
  });
});

describe("idempotent retries", () => {
  it("a retry with the same key returns the same order and charges stock once", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });

    const first = await t.checkout(cartId, "retry-key-0001").expect(201);
    const retry = await t.checkout(cartId, "retry-key-0001").expect(201);

    expect(retry.body.id).toBe(first.body.id);
    expect(first.headers["idempotent-replayed"]).toBe("false");
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(t.ctx.store.orders.size).toBe(1);
    expect(t.ctx.store.products.get("p-mid")!.inventory).toBe(49);
  });

  it("a duplicate sent while the first is still running gets 409 and creates nothing extra", async () => {
    const t = setup({ paymentDelayMs: 50 });
    const cartId = await t.cartWith({ "p-mid": 1 });

    const [a, b] = await Promise.all([t.checkout(cartId, "dup-key-0001"), t.checkout(cartId, "dup-key-0001")]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error.code).toBe("REQUEST_IN_PROGRESS");
    expect(t.ctx.store.orders.size).toBe(1);
  });

  it("rejects reusing a key for a different request", async () => {
    const t = setup();
    const cartA = await t.cartWith({ "p-mid": 1 });
    const cartB = await t.cartWith({ "p-mid": 1 });
    await t.checkout(cartA, "reused-key-0001").expect(201);

    const res = await t.checkout(cartB, "reused-key-0001").expect(422);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("requires an Idempotency-Key", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    const res = await t.api().post(`/carts/${cartId}/checkout`).send({}).expect(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

describe("failed checkout leaves no trace", () => {
  it("a declined payment keeps stock, coupon and cart unchanged, and the same key can retry", async () => {
    const t = setup();
    await t.placeOrders(2);
    const coupon = (await t.api().post("/admin/coupons").expect(201)).body;
    const cartId = await t.cartWith({ "p-last": 2 });

    t.payment.declineNext = 1;
    const declined = await t.checkout(cartId, "decline-key-01", coupon.code).expect(402);
    expect(declined.body.error.code).toBe("PAYMENT_DECLINED");
    expect(t.ctx.store.products.get("p-last")!.inventory).toBe(3);
    expect(t.ctx.store.coupons.get(coupon.code)!.status).toBe("AVAILABLE");
    expect((await t.api().get(`/carts/${cartId}`)).body.status).toBe("OPEN");

    const retried = await t.checkout(cartId, "decline-key-01", coupon.code).expect(201);
    expect(retried.body.discountCents).toBe(1500);
    expect(t.ctx.store.coupons.get(coupon.code)!.status).toBe("REDEEMED");
  });
});

describe("orders", () => {
  it("snapshot the price paid, so later price changes do not rewrite history", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 2 });

    // Price rises after adding to cart but before checkout: the cart shows it and the order charges it.
    await t.api().patch("/admin/products/p-mid").send({ priceCents: 1600 }).expect(200);
    expect((await t.api().get(`/carts/${cartId}`)).body.subtotalCents).toBe(3200);
    const order = (await t.checkout(cartId, "snapshot-key-1").expect(201)).body;

    await t.api().patch("/admin/products/p-mid").send({ priceCents: 9999 }).expect(200);
    const fetched = (await t.api().get(`/orders/${order.id}`).expect(200)).body;
    expect(fetched.lines[0]).toMatchObject({ name: "Mug", unitPriceCents: 1600, quantity: 2, lineTotalCents: 3200 });
    expect(fetched.totalCents).toBe(3200);
  });

  it("rejects an empty cart and invalid input with distinct error codes", async () => {
    const t = setup();
    const cartId = (await t.api().post("/carts").expect(201)).body.id;

    expect((await t.checkout(cartId, "empty-cart-key").expect(422)).body.error.code).toBe("CART_EMPTY");
    expect((await t.api().put(`/carts/${cartId}/items/p-mid`).send({ quantity: 0 }).expect(400)).body.error.code).toBe("VALIDATION_ERROR");
    expect((await t.api().put(`/carts/${cartId}/items/p-mid`).send({ quantity: 1.5 }).expect(400)).body.error.code).toBe("VALIDATION_ERROR");
    expect((await t.api().put(`/carts/${cartId}/items/nope`).send({ quantity: 1 }).expect(404)).body.error.code).toBe("PRODUCT_NOT_FOUND");
    expect((await t.api().put(`/carts/${cartId}/items/p-last`).send({ quantity: 4 }).expect(409)).body.error.code).toBe("INSUFFICIENT_INVENTORY");
    expect((await t.api().get(`/carts/${cartId}`)).body.items).toHaveLength(0);
  });
});
