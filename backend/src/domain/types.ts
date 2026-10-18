export interface Product {
  id: string;
  name: string;
  priceCents: number;
  inventory: number;
}

export type CartStatus = "OPEN" | "CHECKED_OUT";

export interface Cart {
  id: string;
  status: CartStatus;
  /** productId -> quantity. Prices are not stored: a cart always shows current prices. */
  items: Map<string, number>;
  orderId: string | null;
  createdAt: string;
}

/** Snapshot of what was bought, so an order stays explainable if the product changes later. */
export interface OrderLine {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  cartId: string;
  lines: OrderLine[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  coupon: { code: string; percentOff: number } | null;
  payment: { provider: "fake"; reference: string };
  createdAt: string;
}

export type CouponStatus = "AVAILABLE" | "REDEEMED";

export interface Coupon {
  code: string;
  percentOff: number;
  /** k-th milestone: unlocked by the (k * n)-th placed order. */
  milestone: number;
  unlockedAtOrderCount: number;
  status: CouponStatus;
  createdAt: string;
  redeemedByOrderId: string | null;
}

export interface CheckoutResponse {
  status: number;
  body: Order;
}

export type IdempotencyRecord =
  | { state: "IN_PROGRESS"; fingerprint: string }
  | { state: "COMPLETED"; fingerprint: string; response: CheckoutResponse };

export interface Config {
  /** Every n-th placed order unlocks one coupon. */
  couponEveryNOrders: number;
  /** Coupon discount in whole percent (1-100). */
  couponPercentOff: number;
}
