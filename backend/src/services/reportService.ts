import type { Context } from "../context.js";

/** Derived entirely from stored orders and coupons. Reads only, so repeated calls never change state. */
export function buildReport(ctx: Context) {
  const { store, config } = ctx;
  const byProduct = new Map<string, { productId: string; name: string; quantity: number; revenueCents: number }>();
  let grossRevenueCents = 0;
  let totalDiscountCents = 0;

  for (const order of store.orders.values()) {
    grossRevenueCents += order.subtotalCents;
    totalDiscountCents += order.discountCents;
    for (const line of order.lines) {
      const row = byProduct.get(line.productId) ?? { productId: line.productId, name: line.name, quantity: 0, revenueCents: 0 };
      row.quantity += line.quantity;
      row.revenueCents += line.lineTotalCents;
      byProduct.set(line.productId, row);
    }
  }

  const coupons = [...store.coupons.values()];
  const redeemed = coupons.filter((coupon) => coupon.status === "REDEEMED").length;

  return {
    ordersPlaced: store.orders.size,
    productsSold: [...byProduct.values()].sort((a, b) => b.quantity - a.quantity),
    grossRevenueCents,
    totalDiscountCents,
    netRevenueCents: grossRevenueCents - totalDiscountCents,
    coupons: { generated: coupons.length, available: coupons.length - redeemed, redeemed },
    couponRule: {
      everyNOrders: config.couponEveryNOrders,
      percentOff: config.couponPercentOff,
      eligibleUnrewardedMilestones: Math.floor(store.placedOrders / config.couponEveryNOrders) - coupons.length,
    },
  };
}
