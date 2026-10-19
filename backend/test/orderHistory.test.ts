/** GET /admin/orders. IDs H1–H6 match docs/TEST_PLAN.md. */
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("GET /admin/orders (order history)", () => {
  it("H1 empty store returns an empty page", async () => {
    const t = setup();
    expect((await t.api().get("/admin/orders").expect(200)).body).toEqual({ orders: [], total: 0, limit: 20, offset: 0 });
  });

  it("H2 lists orders newest first with a summary of each", async () => {
    const t = setup();
    await t.placeOrders(2);
    const { code } = (await t.api().post("/admin/coupons").expect(201)).body;
    const cartId = await t.cartWith({ "p-mid": 2, "p-cheap": 1 });
    const latest = (await t.checkout(cartId, "history-latest", code).expect(201)).body;

    const page = (await t.api().get("/admin/orders").expect(200)).body;
    expect(page.total).toBe(3);
    expect(page.orders[0]).toEqual({
      id: latest.id,
      status: "CONFIRMED",
      cartId,
      customerId: null,
      createdAt: latest.createdAt,
      itemCount: 3,
      subtotalCents: 3099,
      discountCents: 310,
      totalCents: 2789,
      couponCode: code,
    });
    expect(page.orders[2].couponCode).toBeNull();
  });

  it("H3 paginates with limit and offset", async () => {
    const t = setup();
    await t.placeOrders(5);
    const all = (await t.api().get("/admin/orders?limit=100").expect(200)).body.orders.map((o: { id: string }) => o.id);
    const first = (await t.api().get("/admin/orders?limit=2&offset=0").expect(200)).body;
    const second = (await t.api().get("/admin/orders?limit=2&offset=2").expect(200)).body;
    const beyond = (await t.api().get("/admin/orders?limit=2&offset=10").expect(200)).body;
    expect(first.orders.map((o: { id: string }) => o.id)).toEqual(all.slice(0, 2));
    expect(second.orders.map((o: { id: string }) => o.id)).toEqual(all.slice(2, 4));
    expect(beyond).toMatchObject({ orders: [], total: 5 });
  });

  it("H4 failed checkouts and replayed retries never appear", async () => {
    const t = setup();
    const ok = await t.cartWith({ "p-mid": 1 });
    await t.checkout(ok, "history-replay").expect(201);
    await t.checkout(ok, "history-replay").expect(201); // replay, not a new order
    const declined = await t.cartWith({ "p-mid": 1 });
    t.payment.declineNext = 1;
    await t.checkout(declined, "history-declined").expect(402);
    await t.checkout((await t.api().post("/carts")).body.id, "history-empty").expect(422);

    const page = (await t.api().get("/admin/orders").expect(200)).body;
    expect(page.total).toBe(1);
    expect(page.orders[0].cartId).toBe(ok);
  });

  it.each([
    ["limit=0", "limit"],
    ["limit=101", "limit"],
    ["limit=abc", "limit"],
    ["offset=-1", "offset"],
    ["offset=1.5", "offset"],
    ["page=2", ""],
  ])("H5 rejects ?%s with VALIDATION_ERROR", async (query, field) => {
    const t = setup();
    const res = await t.api().get(`/admin/orders?${query}`).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    if (field) expect(res.body.error.details.issues[0].path).toBe(field);
  });

  it("H6 matches the report: same count, and totals add up to net revenue", async () => {
    const t = setup();
    await t.placeOrders(3);
    const page = (await t.api().get("/admin/orders").expect(200)).body;
    const report = (await t.api().get("/admin/report").expect(200)).body;
    expect(page.total).toBe(report.ordersPlaced);
    expect(page.orders.reduce((sum: number, o: { totalCents: number }) => sum + o.totalCents, 0)).toBe(report.netRevenueCents);
  });
});
