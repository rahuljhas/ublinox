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
  warnings: string[];
}

export interface Order {
  id: string;
  status: "CONFIRMED";
  cartId: string;
  customerId: string | null;
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

export interface OrderPage {
  orders: OrderSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CustomerOrderPage {
  orders: Order[];
  total: number;
  limit: number;
  offset: number;
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

/** Local dev: "/api" (Vite proxies it to localhost:3000). Production: the deployed API, e.g. https://ublinox-api.onrender.com */
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || "/api";

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
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
  createCart: (customerId?: string) => call<CartView>("POST", "/carts", customerId ? { customerId } : {}).then((r) => r.data),
  customerOrders: (customerId: string, limit = 50, offset = 0) =>
    call<CustomerOrderPage>("GET", `/orders?customerId=${encodeURIComponent(customerId)}&limit=${limit}&offset=${offset}`).then((r) => r.data),
  getCart: (id: string) => call<CartView>("GET", `/carts/${id}`).then((r) => r.data),
  setQuantity: (cartId: string, productId: string, quantity: number) =>
    call<CartView>("PUT", `/carts/${cartId}/items/${productId}`, { quantity }).then((r) => r.data),
  removeItem: (cartId: string, productId: string) =>
    call<CartView>("DELETE", `/carts/${cartId}/items/${productId}`).then((r) => r.data),
  /** expectedSubtotalCents: the subtotal the customer saw. The server refuses with PRICE_CHANGED if it differs. */
  checkout: (cartId: string, idempotencyKey: string, couponCode?: string, expectedSubtotalCents?: number) =>
    call<Order>(
      "POST",
      `/carts/${cartId}/checkout`,
      { ...(couponCode ? { couponCode } : {}), ...(expectedSubtotalCents !== undefined ? { expectedSubtotalCents } : {}) },
      { "Idempotency-Key": idempotencyKey },
    ),
  getOrder: (id: string) => call<Order>("GET", `/orders/${id}`).then((r) => r.data),
  checkCoupon: (code: string) => call<Pick<Coupon, "code" | "percentOff" | "status">>("GET", `/coupons/${encodeURIComponent(code)}`).then((r) => r.data),
  admin: {
    report: () => call<Report>("GET", "/admin/report").then((r) => r.data),
    coupons: () => call<Coupon[]>("GET", "/admin/coupons").then((r) => r.data),
    orders: (limit: number, offset: number) => call<OrderPage>("GET", `/admin/orders?limit=${limit}&offset=${offset}`).then((r) => r.data),
    generateCoupon: () => call<Coupon>("POST", "/admin/coupons").then((r) => r.data),
    updateProduct: (id: string, patch: { priceCents?: number; inventory?: number }) =>
      call<Product>("PATCH", `/admin/products/${id}`, patch).then((r) => r.data),
  },
};

export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
