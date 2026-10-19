import { randomUUID } from "node:crypto";
import type { Context } from "../context.js";
import { Errors } from "../domain/errors.js";
import type { Cart } from "../domain/types.js";

export interface CartView {
  id: string;
  status: Cart["status"];
  orderId: string | null;
  customerId: string | null;
  items: {
    productId: string;
    name: string;
    unitPriceCents: number;
    quantity: number;
    lineTotalCents: number;
    availableInventory: number;
    inStock: boolean;
  }[];
  itemCount: number;
  subtotalCents: number;
  /** Lines whose requested quantity is above current stock. Checkout would reject them. */
  warnings: string[];
}

export function getCart(ctx: Context, cartId: string): Cart {
  const cart = ctx.store.carts.get(cartId);
  if (!cart) throw Errors.cartNotFound(cartId);
  return cart;
}

export function createCart(ctx: Context, customerId: string | null = null): CartView {
  const cart: Cart = { id: randomUUID(), status: "OPEN", items: new Map(), orderId: null, customerId, createdAt: new Date().toISOString() };
  ctx.store.carts.set(cart.id, cart);
  return viewCart(ctx, cart.id);
}

/** Priced with current product prices. The order captures prices only at checkout. */
export function viewCart(ctx: Context, cartId: string): CartView {
  const cart = getCart(ctx, cartId);
  const items = [...cart.items].map(([productId, quantity]) => {
    const product = ctx.store.products.get(productId)!;
    return {
      productId,
      name: product.name,
      unitPriceCents: product.priceCents,
      quantity,
      lineTotalCents: product.priceCents * quantity,
      availableInventory: product.inventory,
      inStock: product.inventory >= quantity,
    };
  });
  return {
    id: cart.id,
    status: cart.status,
    orderId: cart.orderId,
    customerId: cart.customerId,
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    subtotalCents: items.reduce((sum, item) => sum + item.lineTotalCents, 0),
    warnings: items
      .filter((item) => !item.inStock)
      .map((item) => `${item.name}: ${item.quantity} requested, ${item.availableInventory} in stock`),
  };
}

/**
 * Adds an item or sets its quantity. Takes the cart lock so it cannot change items while a
 * checkout of the same cart is waiting on payment.
 */
export async function setItemQuantity(ctx: Context, cartId: string, productId: string, quantity: number): Promise<CartView> {
  getCart(ctx, cartId);
  const release = await ctx.mutex.acquire([`cart:${cartId}`]);
  try {
    const cart = getCart(ctx, cartId);
    if (cart.status !== "OPEN") throw Errors.cartNotOpen(cart.id, cart.orderId);
    const product = ctx.store.products.get(productId);
    if (!product) throw Errors.productNotFound(productId);
    if (quantity > product.inventory) {
      throw Errors.insufficientInventory([{ productId, requested: quantity, available: product.inventory }]);
    }
    cart.items.set(productId, quantity);
    return viewCart(ctx, cartId);
  } finally {
    release();
  }
}

export async function removeItem(ctx: Context, cartId: string, productId: string): Promise<CartView> {
  getCart(ctx, cartId);
  const release = await ctx.mutex.acquire([`cart:${cartId}`]);
  try {
    const cart = getCart(ctx, cartId);
    if (cart.status !== "OPEN") throw Errors.cartNotOpen(cart.id, cart.orderId);
    if (!cart.items.delete(productId)) throw Errors.itemNotInCart(productId);
    return viewCart(ctx, cartId);
  } finally {
    release();
  }
}
