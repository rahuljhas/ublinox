import type { Context } from "../context.js";
import type { Order } from "../domain/types.js";

export interface OrderSummary {
  id: string;
  status: string;
  cartId: string;
  customerId: string | null;
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
    customerId: order.customerId,
    createdAt: order.createdAt,
    itemCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    couponCode: order.coupon?.code ?? null,
  }));
  return { orders, total: all.length, limit: page.limit, offset: page.offset };
}

/**
 * One customer's orders, newest first, with their line items. There is no login, so the customer id is
 * whatever the client says it is: this is a demo of per-customer history, not access control.
 */
export function listCustomerOrders(ctx: Context, customerId: string, page: { limit: number; offset: number }) {
  const mine: Order[] = [...ctx.store.orders.values()].filter((order) => order.customerId === customerId).reverse();
  return { orders: mine.slice(page.offset, page.offset + page.limit), total: mine.length, limit: page.limit, offset: page.offset };
}
