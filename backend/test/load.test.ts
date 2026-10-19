/**
 * Many shoppers at the same moment. IDs L1–L3 match docs/TEST_PLAN.md.
 * Same checks as `npm run load`, but in-process so they run with every `npm test`.
 * Test products: p-cheap ×100, p-mid ×50, p-last ×3.
 */
import { describe, expect, it } from "vitest";
import { SEED, setup } from "./helpers.js";

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
}
const stock = (t: ReturnType<typeof setup>, id: string) => t.ctx.store.products.get(id)!.inventory;

function soldByProduct(t: ReturnType<typeof setup>) {
  const sold = new Map<string, number>();
  for (const order of t.ctx.store.orders.values()) for (const line of order.lines) sold.set(line.productId, (sold.get(line.productId) ?? 0) + line.quantity);
  return sold;
}

describe("load", () => {
  it("L1 120 shoppers check out at once: no 5xx, stock and money add up, one order per cart", async () => {
    const t = setup({ paymentDelayMs: 5 });
    const random = rng(2024);

    const results = await Promise.all(
      Array.from({ length: 120 }, async (_, i) => {
        const wanted = [...SEED].sort(() => random() - 0.5).slice(0, 1 + Math.floor(random() * 3));
        const cart = (await t.api().post("/carts")).body.id as string;
        let added = 0;
        for (const p of wanted) added += (await t.api().put(`/carts/${cart}/items/${p.id}`).send({ quantity: 1 + Math.floor(random() * 2) })).status === 200 ? 1 : 0;
        if (!added) return { cart, status: 0, body: null };
        const res = await t.checkout(cart, `load-l1-${i}`);
        return { cart, status: res.status, body: res.body };
      }),
    );

    const attempted = results.filter((r) => r.status !== 0);
    expect(attempted.every((r) => r.status === 201 || (r.status === 409 && r.body.error.code === "INSUFFICIENT_INVENTORY"))).toBe(true);
    const wins = attempted.filter((r) => r.status === 201);
    expect(wins.length).toBeGreaterThan(50);

    const orders = [...t.ctx.store.orders.values()];
    expect(orders).toHaveLength(wins.length);
    expect(new Set(orders.map((o) => o.cartId)).size).toBe(orders.length); // one order per cart
    const sold = soldByProduct(t);
    for (const p of SEED) {
      expect(stock(t, p.id)).toBeGreaterThanOrEqual(0);
      expect(p.inventory - stock(t, p.id)).toBe(sold.get(p.id) ?? 0);
    }
    expect(stock(t, "p-last")).toBe(0); // the limited product sold out, and no more than its 3 units
    expect(sold.get("p-last")).toBe(3);
    const report = (await t.api().get("/admin/report")).body;
    expect(report.ordersPlaced).toBe(orders.length);
    expect(report.netRevenueCents).toBe(orders.reduce((s, o) => s + o.totalCents, 0));
    expect(t.payment.charges.filter((c) => c.approved)).toHaveLength(orders.length); // nobody who lost was charged
  });

  it("L2 more shoppers than the line can hold: the rest get 503 with Retry-After, are never charged, and can retry", async () => {
    const t = setup({ paymentDelayMs: 40, config: { lockWaitMs: 100 } });
    const carts = await Promise.all(Array.from({ length: 30 }, () => t.cartWith({ "p-cheap": 1 })));

    const res = await Promise.all(carts.map((cart, i) => t.checkout(cart, `load-l2-${i}`)));

    expect(res.every((r) => r.status === 201 || r.status === 503)).toBe(true);
    const busy = res.filter((r) => r.status === 503);
    const ok = res.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThan(0);
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.every((r) => r.body.error.code === "SERVER_BUSY" && r.headers["retry-after"] === "2")).toBe(true);
    expect(t.payment.charges).toHaveLength(ok.length); // shed requests never reached payment
    expect(stock(t, "p-cheap")).toBe(100 - ok.length);

    // Everyone who was told to retry can, with the same key, once the queue has drained.
    for (const [i, r] of res.entries()) if (r.status === 503) await t.checkout(carts[i], `load-l2-${i}`).expect(201);
    expect(t.ctx.store.orders.size).toBe(30);
    expect(stock(t, "p-cheap")).toBe(70);
    expect(new Set([...t.ctx.store.orders.values()].map((o) => o.cartId)).size).toBe(30);
  });

  it("L3 40 shoppers each double-click: exactly one order and one stock decrement each", async () => {
    const t = setup({ paymentDelayMs: 10 });
    const carts = await Promise.all(Array.from({ length: 40 }, () => t.cartWith({ "p-cheap": 1 })));

    const pairs = await Promise.all(carts.map(async (cart, i) => Promise.all([t.checkout(cart, `load-l3-${i}`), t.checkout(cart, `load-l3-${i}`)])));

    for (const pair of pairs) {
      expect(pair.filter((r) => r.status === 201)).toHaveLength(1);
      expect(pair.find((r) => r.status !== 201)!.body.error.code).toBe("REQUEST_IN_PROGRESS");
    }
    expect(t.ctx.store.orders.size).toBe(40);
    expect(stock(t, "p-cheap")).toBe(60);
    expect(t.payment.charges).toHaveLength(40);
  });
});
