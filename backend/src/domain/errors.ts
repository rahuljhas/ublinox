/** Every failure the API returns. `code` is stable and meant for clients to branch on. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const Errors = {
  validation: (details: Record<string, unknown>) =>
    new AppError(400, "VALIDATION_ERROR", "The request is invalid.", details),
  idempotencyKeyRequired: () =>
    new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Send one Idempotency-Key header with checkout: 8-100 characters, letters, digits and . _ : - only."),
  productNotFound: (productId: string) =>
    new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist.`, { productId }),
  cartNotFound: (cartId: string) => new AppError(404, "CART_NOT_FOUND", `Cart ${cartId} does not exist.`, { cartId }),
  orderNotFound: (orderId: string) =>
    new AppError(404, "ORDER_NOT_FOUND", `Order ${orderId} does not exist.`, { orderId }),
  itemNotInCart: (productId: string) =>
    new AppError(404, "ITEM_NOT_IN_CART", `Product ${productId} is not in this cart.`, { productId }),
  couponNotFound: (code: string) => new AppError(404, "COUPON_NOT_FOUND", `Coupon ${code} does not exist.`, { code }),
  cartNotOpen: (cartId: string, orderId: string | null) =>
    new AppError(409, "CART_ALREADY_CHECKED_OUT", "This cart has already been checked out.", { cartId, orderId }),
  insufficientInventory: (lines: { productId: string; requested: number; available: number }[]) =>
    new AppError(409, "INSUFFICIENT_INVENTORY", "Not enough stock for one or more items.", { lines }),
  couponAlreadyRedeemed: (code: string) =>
    new AppError(409, "COUPON_ALREADY_REDEEMED", `Coupon ${code} has already been used.`, { code }),
  requestInProgress: () =>
    new AppError(409, "REQUEST_IN_PROGRESS", "A checkout with this Idempotency-Key is still running. Retry shortly."),
  noEligibleMilestone: (details: Record<string, unknown>) =>
    new AppError(409, "NO_ELIGIBLE_MILESTONE", "No unrewarded order milestone has been reached yet.", details),
  cartEmpty: (cartId: string) => new AppError(422, "CART_EMPTY", "Add at least one item before checking out.", { cartId }),
  idempotencyKeyReused: () =>
    new AppError(422, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request."),
  paymentDeclined: (reason: string) =>
    new AppError(402, "PAYMENT_DECLINED", "The payment was declined. Nothing was charged or reserved.", { reason }),
  notFound: () => new AppError(404, "ROUTE_NOT_FOUND", "No such endpoint."),
};
