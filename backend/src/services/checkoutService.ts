import { randomUUID } from "node:crypto";
import type { Context } from "../context.js";
import { Errors } from "../domain/errors.js";
import { applyPercentDiscount } from "../domain/money.js";
import type { CheckoutResponse, Order, OrderLine } from "../domain/types.js";
import { getCart } from "./cartService.js";

export interface CheckoutResult extends CheckoutResponse {
  replayed: boolean;
}

/**
 * Checkout flow (see docs/checkout-sequence.png):
 *  1. claim the Idempotency-Key (synchronous check-and-set, so two requests cannot both claim it)
 *  2. lock the cart, then the coupon and products (sorted, so no deadlock)
 *  3. validate cart state, stock and coupon, and price the order in integer cents
 *  4. await payment (the only await while holding locks)
 *  5. commit every write in one synchronous block, then store the response under the key
 * Any failure before step 5 writes nothing and frees the key, so the client can fix and retry.
 */
export async function checkout(
  ctx: Context,
  input: { cartId: string; idempotencyKey: string; couponCode?: string },
): Promise<CheckoutResult> {
  const { store } = ctx;
  const couponCode = input.couponCode?.trim().toUpperCase() || null;
  const fingerprint = JSON.stringify({ cartId: input.cartId, couponCode });

  const existing = store.idempotency.get(input.idempotencyKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw Errors.idempotencyKeyReused();
    if (existing.state === "IN_PROGRESS") throw Errors.requestInProgress();
    return { ...existing.response, replayed: true };
  }
  store.idempotency.set(input.idempotencyKey, { state: "IN_PROGRESS", fingerprint });

  const releases: Array<() => void> = [];
  try {
    getCart(ctx, input.cartId);
    releases.push(await ctx.mutex.acquire([`cart:${input.cartId}`]));

    const cart = getCart(ctx, input.cartId);
    if (cart.status !== "OPEN") throw Errors.cartNotOpen(cart.id, cart.orderId);
    if (cart.items.size === 0) throw Errors.cartEmpty(cart.id);

    const productIds = [...cart.items.keys()];
    releases.push(
      await ctx.mutex.acquire([...productIds.map((id) => `product:${id}`), ...(couponCode ? [`coupon:${couponCode}`] : [])]),
    );

    // Validate under the locks: nobody else can change these products or this coupon now.
    const shortages = [...cart.items].flatMap(([productId, quantity]) => {
      const product = store.products.get(productId)!;
      return product.inventory < quantity ? [{ productId, requested: quantity, available: product.inventory }] : [];
    });
    if (shortages.length > 0) throw Errors.insufficientInventory(shortages);

    const coupon = couponCode ? store.coupons.get(couponCode) : undefined;
    if (couponCode && !coupon) throw Errors.couponNotFound(couponCode);
    if (coupon && coupon.status !== "AVAILABLE") throw Errors.couponAlreadyRedeemed(coupon.code);

    const lines: OrderLine[] = [...cart.items].map(([productId, quantity]) => {
      const product = store.products.get(productId)!;
      return {
        productId,
        name: product.name,
        unitPriceCents: product.priceCents,
        quantity,
        lineTotalCents: product.priceCents * quantity,
      };
    });
    const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
    const { discountCents, totalCents } = coupon
      ? applyPercentDiscount(subtotalCents, coupon.percentOff)
      : { discountCents: 0, totalCents: subtotalCents };

    const payment = await ctx.payment.charge({ cartId: cart.id, amountCents: totalCents });
    if (!payment.approved) throw Errors.paymentDeclined(payment.reason);

    // Commit: synchronous from here to the return, so no other request can observe a half-done checkout.
    const order: Order = {
      id: randomUUID(),
      cartId: cart.id,
      lines,
      subtotalCents,
      discountCents,
      totalCents,
      coupon: coupon ? { code: coupon.code, percentOff: coupon.percentOff } : null,
      payment: { provider: "fake", reference: payment.reference },
      createdAt: new Date().toISOString(),
    };
    for (const line of lines) store.products.get(line.productId)!.inventory -= line.quantity;
    if (coupon) {
      coupon.status = "REDEEMED";
      coupon.redeemedByOrderId = order.id;
    }
    store.orders.set(order.id, order);
    cart.status = "CHECKED_OUT";
    cart.orderId = order.id;
    store.placedOrders += 1;

    const response: CheckoutResponse = { status: 201, body: order };
    store.idempotency.set(input.idempotencyKey, { state: "COMPLETED", fingerprint, response });
    return { ...response, replayed: false };
  } catch (error) {
    store.idempotency.delete(input.idempotencyKey);
    throw error;
  } finally {
    for (const release of releases.reverse()) release();
  }
}

export function getOrder(ctx: Context, orderId: string): Order {
  const order = ctx.store.orders.get(orderId);
  if (!order) throw Errors.orderNotFound(orderId);
  return order;
}
