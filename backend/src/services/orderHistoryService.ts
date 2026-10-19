import type { Context } from "../context.js";

export interface OrderSummary {
  id: string;
  status: string;
  cartId: string;
  createdAt: string;
  itemCount: number;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  couponCode: string | null;
}

/**
 * Order history, newest first. Only successful checkouts create orders, so failed or replayed
 * checkouts never appear here. Read-only.
 */
export function listOrders(ctx: Context, page: { limit: number; offset: number }) {
  const all = [...ctx.store.orders.values()].reverse();
  const orders: OrderSummary[] = all.slice(page.offset, page.offset + page.limit).map((order) => ({
    id: order.id,
    status: order.status,
    cartId: order.cartId,
    createdAt: order.createdAt,
    itemCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    couponCode: order.coupon?.code ?? null,
  }));
  return { orders, total: all.length, limit: page.limit, offset: page.offset };
}
