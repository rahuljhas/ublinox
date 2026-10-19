/**
 * Many shoppers, one product. IDs X1–X14 match docs/TEST_PLAN.md.
 * Test product p-last starts with 3 in stock.
 */
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const stockOf = (t: ReturnType<typeof setup>, id: string) => t.ctx.store.products.get(id)!.inventory;

describe("many shoppers, one product", () => {
  it("X1 adding to cart does not reserve stock: 10 shoppers can each hold all 3 units", async () => {
    const t = setup();
    const carts = await Promise.all(Array.from({ length: 10 }, () => t.api().post("/carts").then((r) => r.body.id)));
    const adds = await Promise.all(carts.map((id) => t.api().put(`/carts/${id}/items/p-last`).send({ quantity: 3 })));
    expect(adds.every((r) => r.status === 200)).toBe(true);
    expect(stockOf(t, "p-last")).toBe(3); // nothing is taken until checkout
  });

  it("X2 exactly enough stock: 3 shoppers, 3 units, all succeed", async () => {
    const t = setup();
    const carts = await Promise.all(Array.from({ length: 3 }, () => t.cartWith({ "p-last": 1 })));
    const res = await Promise.all(carts.map((id, i) => t.checkout(id, `exact-stock-${i}`)));
    expect(res.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(stockOf(t, "p-last")).toBe(0);
  });

  it("X3 50 shoppers race for 3 units: exactly 3 win, 47 get INSUFFICIENT_INVENTORY", async () => {
    const t = setup({ paymentDelayMs: 5 });
    const carts = await Promise.all(Array.from({ length: 50 }, () => t.cartWith({ "p-last": 1 })));
    const res = await Promise.all(carts.map((id, i) => t.checkout(id, `fifty-race-${i}`)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(3);
    const losers = res.filter((r) => r.status !== 201);
    expect(losers).toHaveLength(47);
    expect(losers.every((r) => r.status === 409 && r.body.error.code === "INSUFFICIENT_INVENTORY")).toBe(true);
    expect(stockOf(t, "p-last")).toBe(0);
  });

  it("X4 different quantities (2, 2, 1) for 3 units: never oversold, the loser is told what is left", async () => {
    const t = setup();
    const carts = await Promise.all([2, 2, 1].map((q) => t.cartWith({ "p-last": q })));
    const res = await Promise.all(carts.map((id, i) => t.checkout(id, `mixed-qty-${i}`)));
    const sold = res.filter((r) => r.status === 201).reduce((sum, r) => sum + r.body.lines[0].quantity, 0);
    expect(sold).toBe(3);
    const loser = res.find((r) => r.status === 409)!;
    const [line] = loser.body.error.details.lines;
    expect(line.available).toBeLessThan(line.requested);
    expect(stockOf(t, "p-last")).toBe(0);
  });

  it("X5 carts listing the same two products in opposite order do not deadlock", async () => {
    // Deadlock recipe if locks were taken in cart order: X holds p-last (paying); A queues on p-last;
    // B takes p-mid then waits on p-last; X finishes, A takes p-last and waits on p-mid → A and B wait forever.
    const t = setup({ paymentDelayMs: 40 });
    const x = await t.cartWith({ "p-last": 1 });
    const a = await t.cartWith({ "p-last": 1, "p-mid": 1 });
    const b = await t.cartWith({ "p-mid": 1, "p-last": 1 });
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const reqX = t.checkout(x, "deadlock-x-key").then((r) => r);
    await pause(10);
    const reqA = t.checkout(a, "deadlock-a-key").then((r) => r);
    await pause(10);
    const reqB = t.checkout(b, "deadlock-b-key").then((r) => r);
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlock: checkouts did not finish")), 3000));
    const res = await Promise.race([Promise.all([reqX, reqA, reqB]), timeout]);
    expect(res.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(stockOf(t, "p-last")).toBe(0);
    expect(stockOf(t, "p-mid")).toBe(48);
  });

  it("X6 all-or-nothing: if one item sells out, the other items in that cart are not taken", async () => {
    const t = setup();
    const mixed = await t.cartWith({ "p-last": 3, "p-mid": 5 });
    const rival = await t.cartWith({ "p-last": 1 });
    await t.checkout(rival, "rival-wins-key").expect(201);
    const res = await t.checkout(mixed, "mixed-loses-key").expect(409);
    expect(res.body.error.details.lines).toEqual([{ productId: "p-last", requested: 3, available: 2 }]);
    expect(stockOf(t, "p-mid")).toBe(50);
  });

  it("X7 the loser can lower the quantity and retry with the same key", async () => {
    const t = setup();
    const winner = await t.cartWith({ "p-last": 2 });
    const loser = await t.cartWith({ "p-last": 2 });
    await t.checkout(winner, "winner-key-001").expect(201);
    await t.checkout(loser, "loser-key-0001").expect(409);
    await t.api().put(`/carts/${loser}/items/p-last`).send({ quantity: 1 }).expect(200);
    await t.checkout(loser, "loser-key-0001").expect(201);
    expect(stockOf(t, "p-last")).toBe(0);
  });

  it("X8 a failed attempt is not cached: the same key is re-evaluated, and succeeds after a restock", async () => {
    const t = setup();
    await t.api().patch("/admin/products/p-last").send({ inventory: 0 }).expect(200);
    const cartId = (await t.api().post("/carts")).body.id;
    t.ctx.store.carts.get(cartId)!.items.set("p-last", 1); // item was added while it was still in stock
    await t.checkout(cartId, "restock-key-01").expect(409);
    await t.checkout(cartId, "restock-key-01").expect(409);
    await t.api().patch("/admin/products/p-last").send({ inventory: 1 }).expect(200);
    const ok = await t.checkout(cartId, "restock-key-01").expect(201);
    expect(ok.headers["idempotent-replayed"]).toBe("false");
  });

  it("X9 a declined payment releases its claim: the next shopper in line gets the last unit", async () => {
    const t = setup({ paymentDelayMs: 20 });
    await t.api().patch("/admin/products/p-last").send({ inventory: 1 }).expect(200);
    const carts = await Promise.all([t.cartWith({ "p-last": 1 }), t.cartWith({ "p-last": 1 })]);
    t.payment.declineNext = 1; // whoever pays first is declined
    const res = await Promise.all(carts.map((id, i) => t.checkout(id, `decline-line-${i}`)));
    expect(res.map((r) => r.status).sort()).toEqual([201, 402]);
    expect(stockOf(t, "p-last")).toBe(0);
    expect(t.ctx.store.orders.size).toBe(1);
  });

  it("X10 a restock arriving mid-race never produces negative stock or more sales than units", async () => {
    const t = setup({ paymentDelayMs: 10 });
    const carts = await Promise.all(Array.from({ length: 8 }, () => t.cartWith({ "p-last": 1 })));
    await t.api().patch("/admin/products/p-last").send({ inventory: 0 }).expect(200);
    const checkouts = carts.map((id, i) => t.checkout(id, `restock-race-${i}`));
    const restock = t.api().patch("/admin/products/p-last").send({ inventory: 2 });
    const res = await Promise.all([...checkouts, restock]);
    const wins = res.slice(0, 8).filter((r) => r.status === 201).length;
    expect(wins).toBeLessThanOrEqual(2);
    expect(stockOf(t, "p-last")).toBe(2 - wins);
    expect(res.slice(0, 8).filter((r) => r.status !== 201).every((r) => r.body.error.code === "INSUFFICIENT_INVENTORY")).toBe(true);
  });

  it("X11 a price change sent mid-checkout waits: the in-flight order pays the price it validated", async () => {
    const t = setup({ paymentDelayMs: 60 });
    const first = await t.cartWith({ "p-last": 1 });
    const second = await t.cartWith({ "p-last": 1 });
    const inFlight = t.checkout(first, "price-flight-1").then((r) => r); // .then() sends the request now
    await new Promise((r) => setTimeout(r, 15));
    let checkoutDoneAt = 0;
    void inFlight.then(() => (checkoutDoneAt = Date.now()));
    await t.api().patch("/admin/products/p-last").send({ priceCents: 9900 }).expect(200); // waits for the product lock
    const patchDoneAt = Date.now();
    const order1 = (await inFlight).body;
    expect(checkoutDoneAt).toBeGreaterThan(0); // checkout finished before the price change returned
    expect(checkoutDoneAt).toBeLessThanOrEqual(patchDoneAt);
    const order2 = (await t.checkout(second, "price-flight-2").expect(201)).body;
    expect(order1.totalCents).toBe(7500);
    expect(order2.totalCents).toBe(9900);
  });

  it("X12 a double-clicked 'add' (two identical PUTs) does not double the quantity", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-last": 1 });
    // Both clicks were rendered from the same state (quantity 1), so both send quantity 2.
    const [a, b] = await Promise.all([
      t.api().put(`/carts/${cartId}/items/p-last`).send({ quantity: 2 }),
      t.api().put(`/carts/${cartId}/items/p-last`).send({ quantity: 2 }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await t.api().get(`/carts/${cartId}`)).body.items[0].quantity).toBe(2);
  });

  it("X13 last unit and the only coupon contested at once: one winner gets both, nothing leaks", async () => {
    const t = setup();
    await t.placeOrders(2);
    const { code } = (await t.api().post("/admin/coupons").expect(201)).body;
    await t.api().patch("/admin/products/p-last").send({ inventory: 1 }).expect(200);
    const carts = await Promise.all([t.cartWith({ "p-last": 1 }), t.cartWith({ "p-last": 1 })]);
    const res = await Promise.all(carts.map((id, i) => t.checkout(id, `both-scarce-${i}`, code)));
    const winner = res.find((r) => r.status === 201)!;
    const loser = res.find((r) => r.status !== 201)!;
    expect(winner.body).toMatchObject({ discountCents: 750, totalCents: 6750 });
    expect(["INSUFFICIENT_INVENTORY", "COUPON_ALREADY_REDEEMED"]).toContain(loser.body.error.code);
    expect(stockOf(t, "p-last")).toBe(0);
    expect(t.ctx.store.coupons.get(code)).toMatchObject({ status: "REDEEMED", redeemedByOrderId: winner.body.id });
  });

  it("X14 after a sell-out, losers' carts warn and new adds are refused", async () => {
    const t = setup();
    const carts = await Promise.all(Array.from({ length: 4 }, () => t.cartWith({ "p-last": 1 })));
    await Promise.all(carts.map((id, i) => t.checkout(id, `sellout-${i}`)));
    const loserId = carts.find((id) => t.ctx.store.carts.get(id)!.status === "OPEN")!;
    const view = (await t.api().get(`/carts/${loserId}`)).body;
    expect(view.items[0]).toMatchObject({ inStock: false, availableInventory: 0 });
    expect(view.warnings).toHaveLength(1);
    const freshCart = (await t.api().post("/carts")).body.id;
    expect((await t.api().put(`/carts/${freshCart}/items/p-last`).send({ quantity: 1 }).expect(409)).body.error.code).toBe("INSUFFICIENT_INVENTORY");
  });
});
