import type { Server } from "node:http";
import request from "supertest";
import { afterEach } from "vitest";
import { createContext } from "../src/context.js";
import { FakePaymentGateway } from "../src/domain/payment.js";
import type { Config, Product } from "../src/domain/types.js";
import { createApp } from "../src/http/app.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

export const SEED: Product[] = [
  { id: "p-cheap", name: "Sticker", priceCents: 199, inventory: 100 },
  { id: "p-mid", name: "Mug", priceCents: 1450, inventory: 50 },
  { id: "p-last", name: "Limited Print", priceCents: 7500, inventory: 3 },
];

/** Real HTTP server on a random port, so concurrent requests really overlap in the event loop. */
export function setup(options: { config?: Partial<Config>; paymentDelayMs?: number } = {}) {
  const payment = new FakePaymentGateway(options.paymentDelayMs ?? 20);
  const ctx = createContext({ seed: SEED, config: { couponEveryNOrders: 2, couponPercentOff: 10, ...options.config }, payment });
  const server = createApp(ctx).listen(0);
  servers.push(server);
  const api = () => request(server);

  async function cartWith(items: Record<string, number>): Promise<string> {
    const cart = await api().post("/carts").expect(201);
    for (const [productId, quantity] of Object.entries(items)) {
      await api().put(`/carts/${cart.body.id}/items/${productId}`).send({ quantity }).expect(200);
    }
    return cart.body.id;
  }

  function checkout(cartId: string, key: string, couponCode?: string) {
    return api()
      .post(`/carts/${cartId}/checkout`)
      .set("Idempotency-Key", key)
      .send(couponCode ? { couponCode } : {});
  }

  async function placeOrders(count: number) {
    for (let i = 0; i < count; i++) {
      const cartId = await cartWith({ "p-cheap": 1 });
      await checkout(cartId, `seed-order-${i}-${cartId}`).expect(201);
    }
  }

  return { ctx, payment, api, cartWith, checkout, placeOrders };
}
