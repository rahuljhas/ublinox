import type { Cart, Coupon, IdempotencyRecord, Order, Product } from "./domain/types.js";

/** All state lives here, in process memory. One instance of this class per running server. */
export class Store {
  readonly products = new Map<string, Product>();
  readonly carts = new Map<string, Cart>();
  readonly orders = new Map<string, Order>();
  readonly coupons = new Map<string, Coupon>();
  readonly idempotency = new Map<string, IdempotencyRecord>();
  placedOrders = 0;

  constructor(seed: Product[]) {
    for (const product of seed) this.products.set(product.id, { ...product });
  }
}
