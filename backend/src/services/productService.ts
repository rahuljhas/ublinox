import type { Context } from "../context.js";
import { Errors } from "../domain/errors.js";
import type { Product } from "../domain/types.js";

export function listProducts(ctx: Context): Product[] {
  return [...ctx.store.products.values()];
}

/**
 * Admin change of price or stock. Takes the product lock so it cannot change stock while a
 * checkout that already validated this product is waiting on payment.
 */
export async function updateProduct(
  ctx: Context,
  productId: string,
  patch: { priceCents?: number; inventory?: number },
): Promise<Product> {
  if (!ctx.store.products.has(productId)) throw Errors.productNotFound(productId);
  const release = await ctx.mutex.acquire([`product:${productId}`]);
  try {
    const product = ctx.store.products.get(productId)!;
    if (patch.priceCents !== undefined) product.priceCents = patch.priceCents;
    if (patch.inventory !== undefined) product.inventory = patch.inventory;
    return product;
  } finally {
    release();
  }
}
