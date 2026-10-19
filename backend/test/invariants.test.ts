/**
 * S1: a seeded random mix of concurrent operations, then every invariant from docs/TEST_PLAN.md
 * is checked against the final state. Fixed seed, so a failure is reproducible.
 */
import { describe, expect, it } from "vitest";
import { SEED, setup } from "./helpers.js";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

describe("invariant soak test", () => {
  it.each([1, 7, 42])("S1 invariants hold after 60 random concurrent operations (seed %i)", async (seed) => {
    const t = setup({ paymentDelayMs: 5 });
    const random = rng(seed);
    const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
    const productIds = SEED.map((p) => p.id);

    const carts = await Promise.all(Array.from({ length: 20 }, () => t.api().post("/carts").then((r) => r.body.id as string)));
    const usedKeys: Array<{ cartId: string; key: string; coupon?: string }> = [];
    const responses: Array<{ key: string; status: number; orderId?: string }> = [];

    const operations = Array.from({ length: 60 }, (_, i) => async () => {
      const roll = random();
      const cartId = pick(carts);
      if (roll < 0.35) {
        await t.api().put(`/carts/${cartId}/items/${pick(productIds)}`).send({ quantity: 1 + Math.floor(random() * 3) });
      } else if (roll < 0.7) {
        const coupons = [...t.ctx.store.coupons.keys()];
        const coupon = coupons.length && random() < 0.5 ? pick(coupons) : undefined;
        const attempt = { cartId, key: `soak-${seed}-${i}`, coupon };
        usedKeys.push(attempt);
        const res = await t.checkout(cartId, attempt.key, coupon);
        responses.push({ key: attempt.key, status: res.status, orderId: res.body.id });
      } else if (roll < 0.85 && usedKeys.length) {
        const previous = pick(usedKeys);
        const res = await t.checkout(previous.cartId, previous.key, previous.coupon);
        responses.push({ key: previous.key, status: res.status, orderId: res.body.id });
      } else {
        await t.api().post("/admin/coupons");
      }
    });

    // Run in waves of 10 truly concurrent requests.
    for (let i = 0; i < operations.length; i += 10) {
      await Promise.all(operations.slice(i, i + 10).map((op) => op()));
    }

    const { store, config } = t.ctx;
    const orders = [...store.orders.values()];
    expect(orders.length).toBeGreaterThan(0);

    // I1: no negative stock; sold + remaining = starting stock
    for (const product of SEED) {
      const sold = orders.flatMap((o) => o.lines).filter((l) => l.productId === product.id).reduce((s, l) => s + l.quantity, 0);
      const remaining = store.products.get(product.id)!.inventory;
      expect(remaining).toBeGreaterThanOrEqual(0);
      expect(sold + remaining).toBe(product.inventory);
    }

    // I2: at most one order per cart, and the cart points at it
    const cartIds = orders.map((o) => o.cartId);
    expect(new Set(cartIds).size).toBe(cartIds.length);
    for (const order of orders) expect(store.carts.get(order.cartId)).toMatchObject({ status: "CHECKED_OUT", orderId: order.id });

    // I3: every successful response for one key carries the same order id
    const orderIdsByKey = new Map<string, Set<string>>();
    for (const r of responses.filter((r) => r.status === 201)) {
      orderIdsByKey.set(r.key, (orderIdsByKey.get(r.key) ?? new Set()).add(r.orderId!));
    }
    for (const ids of orderIdsByKey.values()) expect(ids.size).toBe(1);

    // I4: each redeemed coupon belongs to exactly one existing order, and vice versa
    const redeemed = [...store.coupons.values()].filter((c) => c.status === "REDEEMED");
    const ordersWithCoupon = orders.filter((o) => o.coupon);
    expect(redeemed).toHaveLength(ordersWithCoupon.length);
    for (const coupon of redeemed) expect(store.orders.get(coupon.redeemedByOrderId!)?.coupon?.code).toBe(coupon.code);

    // I6: never more coupons than reached milestones
    expect(store.coupons.size).toBeLessThanOrEqual(Math.floor(store.placedOrders / config.couponEveryNOrders));
    expect(store.placedOrders).toBe(orders.length);

    // I7: totals are integer cents, never negative, never above subtotal
    for (const o of orders) {
      expect(Number.isSafeInteger(o.totalCents)).toBe(true);
      expect(o.totalCents).toBeGreaterThanOrEqual(0);
      expect(o.totalCents).toBe(o.subtotalCents - o.discountCents);
      expect(o.subtotalCents).toBe(o.lines.reduce((s, l) => s + l.lineTotalCents, 0));
    }

    // I9: report reconciles with stored orders
    const report = (await t.api().get("/admin/report")).body;
    expect(report.ordersPlaced).toBe(orders.length);
    expect(report.netRevenueCents).toBe(orders.reduce((s, o) => s + o.totalCents, 0));
    expect(report.coupons.redeemed).toBe(redeemed.length);

    // No checkout is left half-finished
    expect([...store.idempotency.values()].every((r) => r.state === "COMPLETED")).toBe(true);
  });
});
