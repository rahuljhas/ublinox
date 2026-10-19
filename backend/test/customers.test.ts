/** Demo customers (no login). IDs CU1–CU8 match docs/TEST_PLAN.md. Test product p-last has 3 in stock. */
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

type T = ReturnType<typeof setup>;
async function cartFor(t: T, customerId: string, items: Record<string, number>) {
  const cart = (await t.api().post("/carts").send({ customerId }).expect(201)).body;
  for (const [productId, quantity] of Object.entries(items)) await t.api().put(`/carts/${cart.id}/items/${productId}`).send({ quantity }).expect(200);
  return cart.id as string;
}
const history = (t: T, customerId: string, query = "") => t.api().get(`/orders?customerId=${customerId}${query}`);

describe("customers", () => {
  it("CU1 a cart and its order carry the customer; no customer means null", async () => {
    const t = setup();
    const anon = (await t.api().post("/carts").expect(201)).body;
    expect(anon.customerId).toBeNull();
    const cartId = await cartFor(t, "u-aisha", { "p-mid": 1 });
    expect((await t.api().get(`/carts/${cartId}`)).body.customerId).toBe("u-aisha");
    const order = (await t.checkout(cartId, "customer-tag-key1").expect(201)).body;
    expect(order.customerId).toBe("u-aisha");
    expect((await t.api().get(`/orders/${order.id}`).expect(200)).body.customerId).toBe("u-aisha");
  });

  it.each([["upper case", { customerId: "U-Aisha" }], ["spaces", { customerId: "u aisha" }], ["empty", { customerId: "" }], ["too long", { customerId: "a".repeat(41) }], ["number", { customerId: 5 }], ["unknown field", { customerId: "u-ben", role: "admin" }]])(
    "CU2 rejects a bad customerId (%s)",
    async (_label, body) => {
      const t = setup();
      expect((await t.api().post("/carts").send(body).expect(400)).body.error.code).toBe("VALIDATION_ERROR");
      expect(t.ctx.store.carts.size).toBe(0);
    },
  );

  it("CU3 GET /orders needs a customerId and returns only that customer's orders, newest first, with lines", async () => {
    const t = setup();
    const a1 = await cartFor(t, "u-aisha", { "p-mid": 1 });
    const b1 = await cartFor(t, "u-ben", { "p-cheap": 2 });
    const a2 = await cartFor(t, "u-aisha", { "p-cheap": 1 });
    const first = (await t.checkout(a1, "history-a1-key1").expect(201)).body;
    await t.checkout(b1, "history-b1-key1").expect(201);
    const second = (await t.checkout(a2, "history-a2-key1").expect(201)).body;

    const aisha = (await history(t, "u-aisha").expect(200)).body;
    expect(aisha.total).toBe(2);
    expect(aisha.orders.map((o: { id: string }) => o.id)).toEqual([second.id, first.id]);
    expect(aisha.orders[1].lines[0]).toMatchObject({ name: "Mug", quantity: 1, unitPriceCents: 1450 });
    const ben = (await history(t, "u-ben").expect(200)).body;
    expect(ben.total).toBe(1);
    expect(ben.orders[0].lines[0].quantity).toBe(2);
    expect((await history(t, "u-chloe").expect(200)).body).toEqual({ orders: [], total: 0, limit: 20, offset: 0 });
  });

  it.each([["missing customerId", ""], ["bad customerId", "?customerId=Ben%20X"], ["limit 0", "?customerId=u-ben&limit=0"], ["unknown parameter", "?customerId=u-ben&page=2"]])(
    "CU4 GET /orders rejects %s",
    async (_label, query) => {
      const t = setup();
      expect((await t.api().get(`/orders${query}`).expect(400)).body.error.code).toBe("VALIDATION_ERROR");
    },
  );

  it("CU5 two customers hold the last unit: one order, the other is refused, and each history shows the truth", async () => {
    const t = setup({ paymentDelayMs: 20 });
    await t.api().patch("/admin/products/p-last").send({ inventory: 1 }).expect(200);
    const aisha = await cartFor(t, "u-aisha", { "p-last": 1 });
    const ben = await cartFor(t, "u-ben", { "p-last": 1 });

    const [ra, rb] = await Promise.all([t.checkout(aisha, "last-unit-aisha1"), t.checkout(ben, "last-unit-ben0001")]);

    const winner = ra.status === 201 ? "u-aisha" : "u-ben";
    const loser = winner === "u-aisha" ? "u-ben" : "u-aisha";
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    expect((await history(t, winner)).body.total).toBe(1);
    expect((await history(t, loser)).body.total).toBe(0);
    expect((await t.api().get(`/carts/${loser === "u-ben" ? ben : aisha}`)).body.status).toBe("OPEN");
    expect(t.payment.charges).toHaveLength(1);
  });

  it("CU6 customers do not share carts: one customer's checkout leaves another's cart open and warns when stock ran out", async () => {
    const t = setup();
    const aisha = await cartFor(t, "u-aisha", { "p-last": 3 });
    const ben = await cartFor(t, "u-ben", { "p-last": 1 });
    await t.checkout(aisha, "no-sharing-aisha1").expect(201);
    const view = (await t.api().get(`/carts/${ben}`)).body;
    expect(view).toMatchObject({ status: "OPEN", customerId: "u-ben" });
    expect(view.items[0]).toMatchObject({ inStock: false, availableInventory: 0 });
    expect((await history(t, "u-ben")).body.total).toBe(0);
  });

  it("CU7 history paginates", async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) await t.checkout(await cartFor(t, "u-chloe", { "p-cheap": 1 }), `page-key-chloe-${i}`).expect(201);
    const all = (await history(t, "u-chloe", "&limit=100")).body.orders.map((o: { id: string }) => o.id);
    expect((await history(t, "u-chloe", "&limit=2&offset=0")).body.orders.map((o: { id: string }) => o.id)).toEqual(all.slice(0, 2));
    expect((await history(t, "u-chloe", "&limit=2&offset=2")).body.orders.map((o: { id: string }) => o.id)).toEqual(all.slice(2));
  });

  it("CU8 the admin order list shows who ordered", async () => {
    const t = setup();
    await t.checkout(await cartFor(t, "u-ben", { "p-mid": 1 }), "admin-sees-ben-1").expect(201);
    await t.placeOrders(1); // an order with no customer
    const rows = (await t.api().get("/admin/orders").expect(200)).body.orders;
    expect(rows.map((r: { customerId: string | null }) => r.customerId)).toEqual([null, "u-ben"]);
  });
});
