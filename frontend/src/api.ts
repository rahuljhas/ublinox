export interface Product {
  id: string;
  name: string;
  priceCents: number;
  inventory: number;
  imageUrl?: string;
}

export interface CartView {
  id: string;
  status: "OPEN" | "CHECKED_OUT";
  orderId: string | null;
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
  warnings: string[];
}

export interface Order {
  id: string;
  cartId: string;
  lines: { productId: string; name: string; unitPriceCents: number; quantity: number; lineTotalCents: number }[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  coupon: { code: string; percentOff: number } | null;
  payment: { provider: string; reference: string };
  createdAt: string;
}

export interface Coupon {
  code: string;
  percentOff: number;
  milestone: number;
  unlockedAtOrderCount: number;
  status: "AVAILABLE" | "REDEEMED";
  createdAt: string;
  redeemedByOrderId: string | null;
}

export interface Report {
  ordersPlaced: number;
  productsSold: { productId: string; name: string; quantity: number; revenueCents: number }[];
  grossRevenueCents: number;
  totalDiscountCents: number;
  netRevenueCents: number;
  coupons: { generated: number; available: number; redeemed: number };
  couponRule: { everyNOrders: number; percentOff: number; eligibleUnrewardedMilestones: number };
}

/** The backend's error contract: { error: { code, message, details } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "NETWORK_ERROR", err.message ?? `Request failed (${res.status})`, err.details);
  }
  return { data: data as T, replayed: res.headers.get("Idempotent-Replayed") === "true" };
}

export const api = {
  products: () => call<Product[]>("GET", "/products").then((r) => r.data),
  createCart: () => call<CartView>("POST", "/carts").then((r) => r.data),
  getCart: (id: string) => call<CartView>("GET", `/carts/${id}`).then((r) => r.data),
  setQuantity: (cartId: string, productId: string, quantity: number) =>
    call<CartView>("PUT", `/carts/${cartId}/items/${productId}`, { quantity }).then((r) => r.data),
  removeItem: (cartId: string, productId: string) =>
    call<CartView>("DELETE", `/carts/${cartId}/items/${productId}`).then((r) => r.data),
  checkout: (cartId: string, idempotencyKey: string, couponCode?: string) =>
    call<Order>("POST", `/carts/${cartId}/checkout`, couponCode ? { couponCode } : {}, { "Idempotency-Key": idempotencyKey }),
  checkCoupon: (code: string) => call<Pick<Coupon, "code" | "percentOff" | "status">>("GET", `/coupons/${encodeURIComponent(code)}`).then((r) => r.data),
  admin: {
    report: () => call<Report>("GET", "/admin/report").then((r) => r.data),
    coupons: () => call<Coupon[]>("GET", "/admin/coupons").then((r) => r.data),
    generateCoupon: () => call<Coupon>("POST", "/admin/coupons").then((r) => r.data),
    updateProduct: (id: string, patch: { priceCents?: number; inventory?: number }) =>
      call<Product>("PATCH", `/admin/products/${id}`, patch).then((r) => r.data),
  },
};

export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
