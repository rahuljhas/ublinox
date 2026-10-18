import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("coupons", () => {
  it("generates exactly one coupon per reached milestone (n = 2)", async () => {
    const t = setup();

    await t.placeOrders(1);
    const early = await t.api().post("/admin/coupons").expect(409);
    expect(early.body.error).toMatchObject({ code: "NO_ELIGIBLE_MILESTONE", details: { nextMilestoneAtOrder: 2 } });

    await t.placeOrders(1);
    const coupon = (await t.api().post("/admin/coupons").expect(201)).body;
    expect(coupon).toMatchObject({ percentOff: 10, milestone: 1, unlockedAtOrderCount: 2, status: "AVAILABLE" });

    await t.api().post("/admin/coupons").expect(409); // milestone 1 already rewarded
    await t.placeOrders(2);
    expect((await t.api().post("/admin/coupons").expect(201)).body.milestone).toBe(2);
  });

  it("concurrent admin requests cannot generate two coupons for one milestone", async () => {
    const t = setup();
    await t.placeOrders(2);

    const results = await Promise.all(Array.from({ length: 5 }, () => t.api().post("/admin/coupons")));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(t.ctx.store.coupons.size).toBe(1);
  });

  it("two checkouts racing with the same coupon: only one gets the discount", async () => {
    const t = setup();
    await t.placeOrders(2);
    const { code } = (await t.api().post("/admin/coupons").expect(201)).body;
    const cartA = await t.cartWith({ "p-mid": 1 });
    const cartB = await t.cartWith({ "p-mid": 1 });

    const [a, b] = await Promise.all([t.checkout(cartA, "coupon-race-a", code), t.checkout(cartB, "coupon-race-b", code)]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = [a, b].find((r) => r.status === 201)!;
    const loser = [a, b].find((r) => r.status === 409)!;
    expect(winner.body).toMatchObject({ subtotalCents: 1450, discountCents: 145, totalCents: 1305 });
    expect(loser.body.error.code).toBe("COUPON_ALREADY_REDEEMED");
    expect(t.ctx.store.coupons.get(code)!.redeemedByOrderId).toBe(winner.body.id);
  });

  it("an unknown coupon fails checkout without touching stock", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    const res = await t.checkout(cartId, "bad-coupon-key", "NOPE-123").expect(404);
    expect(res.body.error.code).toBe("COUPON_NOT_FOUND");
    expect(t.ctx.store.products.get("p-mid")!.inventory).toBe(50);
  });
});

describe("admin report", () => {
  it("reconciles with orders and coupons, and reading it twice changes nothing", async () => {
    const t = setup();
    await t.placeOrders(2); // 2 x $1.99
    const { code } = (await t.api().post("/admin/coupons").expect(201)).body;
    const cartId = await t.cartWith({ "p-mid": 2, "p-last": 1 }); // 2 x 14.50 + 75.00 = 104.00
    await t.checkout(cartId, "report-key-001", code).expect(201); // 10% = 10.40

    const first = (await t.api().get("/admin/report").expect(200)).body;
    const second = (await t.api().get("/admin/report").expect(200)).body;

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      ordersPlaced: 3,
      grossRevenueCents: 398 + 10400,
      totalDiscountCents: 1040,
      netRevenueCents: 398 + 10400 - 1040,
      coupons: { generated: 1, available: 0, redeemed: 1 },
    });
    expect(first.productsSold).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: "p-cheap", quantity: 2 }),
        expect.objectContaining({ productId: "p-mid", quantity: 2 }),
        expect.objectContaining({ productId: "p-last", quantity: 1 }),
      ]),
    );
    const sumOfOrderTotals = [...t.ctx.store.orders.values()].reduce((sum, o) => sum + o.totalCents, 0);
    expect(first.netRevenueCents).toBe(sumOfOrderTotals);
  });
});
