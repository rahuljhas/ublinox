/**
 * The edge-case assignment, one test per case. IDs E1–E10 match docs/EDGE_CASES.md.
 * Test product p-last starts with 3 in stock at $75.00.
 */
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const stockOf = (t: ReturnType<typeof setup>, id: string) => t.ctx.store.products.get(id)!.inventory;

describe("edge-case assignment", () => {
  it("E1 two consecutive orders for the last unit: first gets an order id, second is refused, statuses are correct", async () => {
    const t = setup();
    await t.api().patch("/admin/products/p-last").send({ inventory: 1 }).expect(200);
    const cartA = await t.cartWith({ "p-last": 1 });
    const cartB = await t.cartWith({ "p-last": 1 });

    const first = await t.checkout(cartA, "consecutive-a").expect(201);
    const second = await t.checkout(cartB, "consecutive-b").expect(409);

    expect(first.body).toMatchObject({ status: "CONFIRMED", cartId: cartA, totalCents: 7500 });
    expect(second.body.error).toMatchObject({ code: "INSUFFICIENT_INVENTORY", details: { lines: [{ productId: "p-last", requested: 1, available: 0 }] } });
    expect((await t.api().get(`/orders/${first.body.id}`).expect(200)).body.status).toBe("CONFIRMED");
    expect((await t.api().get(`/carts/${cartA}`)).body).toMatchObject({ status: "CHECKED_OUT", orderId: first.body.id });
    expect((await t.api().get(`/carts/${cartB}`)).body).toMatchObject({ status: "OPEN", orderId: null });
    const history = (await t.api().get("/admin/orders")).body;
    expect(history.orders.map((o: { id: string }) => o.id)).toEqual([first.body.id]);
    expect(stockOf(t, "p-last")).toBe(0);
  });

  it("E2 customer clicks Place order twice: one order, one charge", async () => {
    const t = setup({ paymentDelayMs: 40 });
    const cartId = await t.cartWith({ "p-mid": 1 });
    // The UI sends the same Idempotency-Key for both clicks.
    const [click1, click2] = await Promise.all([t.checkout(cartId, "double-click-1"), t.checkout(cartId, "double-click-1")]);
    expect([click1.status, click2.status].sort()).toEqual([201, 409]);
    // Even if the client generated a new key per click, the cart can only become one order.
    const third = await t.checkout(cartId, "double-click-2").expect(409);
    expect(third.body.error.code).toBe("CART_ALREADY_CHECKED_OUT");
    expect(t.ctx.store.orders.size).toBe(1);
    expect(t.payment.charges.filter((c) => c.approved)).toHaveLength(1);
  });

  it("E3 clicking Add 3 times on the same product: deliberate clicks count, a duplicated request does not", async () => {
    const t = setup();
    const cartId = (await t.api().post("/carts")).body.id;
    for (const quantity of [1, 2, 3]) await t.api().put(`/carts/${cartId}/items/p-last`).send({ quantity }).expect(200);
    expect((await t.api().get(`/carts/${cartId}`)).body.items[0].quantity).toBe(3);

    // A 4th click asks for more than the 3 in stock: refused, quantity stays 3.
    const fourth = await t.api().put(`/carts/${cartId}/items/p-last`).send({ quantity: 4 }).expect(409);
    expect(fourth.body.error.code).toBe("INSUFFICIENT_INVENTORY");
    // The same request sent twice (network retry) sets the same quantity, it does not add again.
    await t.api().put(`/carts/${cartId}/items/p-last`).send({ quantity: 2 }).expect(200);
    await t.api().put(`/carts/${cartId}/items/p-last`).send({ quantity: 2 }).expect(200);
    const cart = (await t.api().get(`/carts/${cartId}`)).body;
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(2);
  });

  it("E4 four customers race for the last unit: only the winner is charged, so no refund is ever needed", async () => {
    const t = setup({ paymentDelayMs: 20 });
    await t.api().patch("/admin/products/p-last").send({ inventory: 1 }).expect(200);
    const carts = await Promise.all(Array.from({ length: 4 }, () => t.cartWith({ "p-last": 1 })));

    const res = await Promise.all(carts.map((id, i) => t.checkout(id, `refund-race-${i}`)));

    const winner = res.find((r) => r.status === 201)!;
    expect(res.filter((r) => r.status === 409)).toHaveLength(3);
    // Stock is checked before payment, under the lock: losers never reach the payment step.
    expect(t.payment.charges).toEqual([{ cartId: winner.body.cartId, amountCents: 7500, approved: true }]);
    expect(stockOf(t, "p-last")).toBe(0);
  });

  it("E5 3 in stock, customer 1 buys 1 then customer 2 asks for 3: told exactly 2 are left, buys 2", async () => {
    const t = setup();
    const c1 = await t.cartWith({ "p-last": 1 });
    const c2 = await t.cartWith({ "p-last": 3 });
    await t.checkout(c1, "categorize-c1").expect(201);

    const refused = await t.checkout(c2, "categorize-c2").expect(409);
    expect(refused.body.error).toMatchObject({
      code: "INSUFFICIENT_INVENTORY",
      details: { lines: [{ productId: "p-last", requested: 3, available: 2 }] },
    });
    expect(t.payment.charges).toHaveLength(1); // customer 2 was not charged

    await t.api().put(`/carts/${c2}/items/p-last`).send({ quantity: 2 }).expect(200);
    const order = (await t.checkout(c2, "categorize-c2").expect(201)).body;
    expect(order.lines[0].quantity).toBe(2);
    expect(stockOf(t, "p-last")).toBe(0);
  });

  it("E5b the same two customers at the same moment: stock is never split wrongly", async () => {
    const t = setup();
    const c1 = await t.cartWith({ "p-last": 1 });
    const c2 = await t.cartWith({ "p-last": 3 });
    const [r1, r2] = await Promise.all([t.checkout(c1, "categorize-par-1"), t.checkout(c2, "categorize-par-2")]);
    const sold = [r1, r2].filter((r) => r.status === 201).reduce((s, r) => s + r.body.lines[0].quantity, 0);
    // Either customer 1 wins (sold 1, customer 2 refused) or customer 2 wins (sold 3, customer 1 refused).
    expect([1, 3]).toContain(sold);
    expect(stockOf(t, "p-last")).toBe(3 - sold);
  });

  it("E6 stock and payment amounts are never negative", async () => {
    const t = setup({ config: { couponPercentOff: 100 } });
    // Admin cannot set negative stock or price.
    expect((await t.api().patch("/admin/products/p-last").send({ inventory: -1 }).expect(400)).body.error.code).toBe("VALIDATION_ERROR");
    expect((await t.api().patch("/admin/products/p-last").send({ priceCents: -100 }).expect(400)).body.error.code).toBe("VALIDATION_ERROR");
    // Selling the last units brings stock to exactly 0, never below.
    const carts = await Promise.all(Array.from({ length: 6 }, () => t.cartWith({ "p-last": 1 })));
    await Promise.all(carts.map((id, i) => t.checkout(id, `never-negative-${i}`)));
    expect(stockOf(t, "p-last")).toBe(0);
    // A 100% coupon makes the charge 0, not negative.
    await t.placeOrders(2);
    const { code } = (await t.api().post("/admin/coupons").expect(201)).body;
    const free = await t.cartWith({ "p-mid": 1 });
    expect((await t.checkout(free, "free-order-e6", code).expect(201)).body.totalCents).toBe(0);
    expect(t.payment.charges.every((c) => c.amountCents >= 0)).toBe(true);
  });

  it("E7 admin changes a price while the customer's page is open: checkout stops and shows the new price", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 2 });
    const shownSubtotal = (await t.api().get(`/carts/${cartId}`)).body.subtotalCents; // 2900, what the page displays
    await t.api().patch("/admin/products/p-mid").send({ priceCents: 1600 }).expect(200);

    const stale = await t.api().post(`/carts/${cartId}/checkout`).set("Idempotency-Key", "price-changed-1").send({ expectedSubtotalCents: shownSubtotal }).expect(409);
    expect(stale.body.error).toMatchObject({
      code: "PRICE_CHANGED",
      details: { expectedSubtotalCents: 2900, currentSubtotalCents: 3200, lines: [{ productId: "p-mid", unitPriceCents: 1600 }] },
    });
    expect(t.payment.charges).toHaveLength(0);
    expect(stockOf(t, "p-mid")).toBe(50);

    // The page reloads the cart (new price shown) and the customer confirms with the same key.
    const fresh = (await t.api().get(`/carts/${cartId}`)).body.subtotalCents;
    const order = await t.api().post(`/carts/${cartId}/checkout`).set("Idempotency-Key", "price-changed-1").send({ expectedSubtotalCents: fresh }).expect(201);
    expect(order.body.totalCents).toBe(3200);
  });

  it("E8 a checkout that does not send expectedSubtotalCents is charged the current price", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    await t.api().patch("/admin/products/p-mid").send({ priceCents: 1000 }).expect(200);
    expect((await t.checkout(cartId, "no-expected-e8").expect(201)).body.totalCents).toBe(1000);
  });

  it("E9 a price drop also counts as a change: the customer is never charged an amount they did not see", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    await t.api().patch("/admin/products/p-mid").send({ priceCents: 999 }).expect(200);
    const res = await t.api().post(`/carts/${cartId}/checkout`).set("Idempotency-Key", "price-drop-e9").send({ expectedSubtotalCents: 1450 }).expect(409);
    expect(res.body.error.details.currentSubtotalCents).toBe(999);
  });

  it("E10 expectedSubtotalCents must be a non-negative integer", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    for (const bad of [-1, 12.5, "1450"]) {
      const res = await t.api().post(`/carts/${cartId}/checkout`).set("Idempotency-Key", `bad-expected-${String(bad)}`).send({ expectedSubtotalCents: bad });
      expect(res.status).toBe(400);
    }
  });
});
