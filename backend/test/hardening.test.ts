/**
 * Backpressure and timeouts. IDs T1–T8 match docs/TEST_PLAN.md.
 *  T1–T3 bounded lock waiting (503 SERVER_BUSY)   T4–T5 payment timeout (504 PAYMENT_TIMEOUT)
 *  T6–T7 idempotency key expiry                    T8   config validation
 */
import { describe, expect, it } from "vitest";
import { createContext } from "../src/context.js";
import { KeyedMutex } from "../src/domain/keyedMutex.js";
import { setup } from "./helpers.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stockOf = (t: ReturnType<typeof setup>, id: string) => t.ctx.store.products.get(id)!.inventory;

describe("bounded lock waiting", () => {
  it("T1 a shopper stuck behind a slow checkout gets 503 SERVER_BUSY with Retry-After, and is not charged", async () => {
    const t = setup({ paymentDelayMs: 300, config: { lockWaitMs: 60 } });
    const slow = await t.cartWith({ "p-mid": 1 });
    const waiting = await t.cartWith({ "p-mid": 1 });

    const first = t.checkout(slow, "slow-checkout-1").then((r) => r); // starts now, holds p-mid for ~300 ms
    await pause(20);
    const busy = await t.checkout(waiting, "waiting-checkout-1").expect(503);

    expect(busy.body.error).toMatchObject({ code: "SERVER_BUSY", details: { resource: "product:p-mid" } });
    expect(busy.headers["retry-after"]).toBe("2");
    expect((await first).status).toBe(201);
    expect(t.payment.charges).toHaveLength(1); // only the first shopper reached payment
    expect((await t.api().get(`/carts/${waiting}`)).body.status).toBe("OPEN");
  });

  it("T2 giving up does not block the line: the next shopper gets through once the slow checkout ends", async () => {
    const t = setup({ paymentDelayMs: 200, config: { lockWaitMs: 50 } });
    const [a, b, c] = await Promise.all([t.cartWith({ "p-mid": 1 }), t.cartWith({ "p-mid": 1 }), t.cartWith({ "p-mid": 1 })]);

    const first = t.checkout(a, "line-first-key1").then((r) => r);
    await pause(20);
    await t.checkout(b, "line-second-key").expect(503); // gives up after 50 ms
    await first; // the slow one finishes (~200 ms)
    await pause(20);
    await t.checkout(c, "line-third-key1").expect(201); // not stuck behind the abandoned place in line
    expect(stockOf(t, "p-mid")).toBe(48);
  });

  it("T3 the busy shopper's idempotency key is freed, so the same key works on retry", async () => {
    const t = setup({ paymentDelayMs: 150, config: { lockWaitMs: 40 } });
    const a = await t.cartWith({ "p-mid": 1 });
    const b = await t.cartWith({ "p-mid": 1 });
    const first = t.checkout(a, "retry-after-busy-a").then((r) => r);
    await pause(20);
    await t.checkout(b, "retry-after-busy-b").expect(503);
    await first;
    expect((await t.checkout(b, "retry-after-busy-b").expect(201)).headers["idempotent-replayed"]).toBe("false");
  });

  it("T3b a multi-key acquire that times out releases the keys it already holds", async () => {
    const mutex = new KeyedMutex(40);
    const holdB = await mutex.acquire(["b"]);
    await expect(mutex.acquire(["a", "b"])).rejects.toMatchObject({ code: "SERVER_BUSY" }); // got "a", timed out on "b"
    holdB();
    const release = await mutex.acquire(["a"]); // "a" was released by the failed acquire
    release();
  });
});

describe("payment timeout", () => {
  it("T4 a hung payment returns 504 PAYMENT_TIMEOUT and writes nothing", async () => {
    const t = setup({ config: { paymentTimeoutMs: 60 } });
    const cartId = await t.cartWith({ "p-mid": 2 });
    t.payment.hangNext = 1;

    const res = await t.checkout(cartId, "hung-payment-key").expect(504);

    expect(res.body.error.code).toBe("PAYMENT_TIMEOUT");
    expect(stockOf(t, "p-mid")).toBe(50);
    expect(t.ctx.store.orders.size).toBe(0);
    expect((await t.api().get(`/carts/${cartId}`)).body.status).toBe("OPEN");
  });

  it("T5 after a payment timeout the locks are free: another shopper buys, and the same key can retry", async () => {
    const t = setup({ config: { paymentTimeoutMs: 60 } });
    const stuck = await t.cartWith({ "p-mid": 1 });
    const other = await t.cartWith({ "p-mid": 1 });
    t.payment.hangNext = 1;
    await t.checkout(stuck, "timeout-then-retry").expect(504);

    await t.checkout(other, "other-shopper-key").expect(201);
    await t.checkout(stuck, "timeout-then-retry").expect(201); // provider answers this time
    expect(stockOf(t, "p-mid")).toBe(48);
  });

  it("T5b the idempotency key is forwarded to the payment provider", async () => {
    const t = setup();
    const cartId = await t.cartWith({ "p-mid": 1 });
    await t.checkout(cartId, "forwarded-key-01").expect(201);
    expect(t.payment.charges[0].idempotencyKey).toBe("forwarded-key-01");
  });
});

describe("idempotency key expiry", () => {
  it("T6 expired keys are forgotten, and a late retry still cannot create a second order", async () => {
    const t = setup({ config: { idempotencyTtlMs: 40 } });
    const cartId = await t.cartWith({ "p-mid": 1 });
    const first = (await t.checkout(cartId, "expiring-key-01").expect(201)).body;
    expect(t.ctx.store.idempotency.has("expiring-key-01")).toBe(true);

    await pause(70);
    await t.checkout((await t.api().post("/carts")).body.id, "any-other-key-01"); // any checkout triggers the sweep
    expect(t.ctx.store.idempotency.has("expiring-key-01")).toBe(false);

    const late = await t.checkout(cartId, "expiring-key-01").expect(409);
    expect(late.body.error).toMatchObject({ code: "CART_ALREADY_CHECKED_OUT", details: { orderId: first.id } });
    expect(t.ctx.store.orders.size).toBe(1);
  });

  it("T7 keys inside the TTL still replay", async () => {
    const t = setup({ config: { idempotencyTtlMs: 60_000 } });
    const cartId = await t.cartWith({ "p-mid": 1 });
    const first = await t.checkout(cartId, "fresh-key-000001").expect(201);
    await t.checkout((await t.api().post("/carts")).body.id, "trigger-sweep-01");
    const again = await t.checkout(cartId, "fresh-key-000001").expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(again.headers["idempotent-replayed"]).toBe("true");
  });
});

describe("configuration", () => {
  it("T8 rejects non-positive or non-integer timeouts at startup", () => {
    expect(() => createContext({ config: { lockWaitMs: 0 } })).toThrow(/LOCK_WAIT_MS/);
    expect(() => createContext({ config: { paymentTimeoutMs: 1.5 } })).toThrow(/PAYMENT_TIMEOUT_MS/);
    expect(() => createContext({ config: { idempotencyTtlMs: -1 } })).toThrow(/IDEMPOTENCY_TTL_MS/);
  });
});
