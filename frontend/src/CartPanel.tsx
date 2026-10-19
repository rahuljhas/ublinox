import { useRef, useState } from "react";
import type { Notify } from "./App";
import { ApiError, api, money, type CartView, type Order } from "./api";
import { rememberOrder } from "./OrderHistory";

interface Attempt {
  cartId: string;
  key: string;
  couponCode?: string;
  expectedSubtotalCents?: number;
}

const NETWORK_RETRIES = 2;

export function CartPanel(props: {
  cart: CartView | null;
  notify: Notify;
  onChange: (action: () => Promise<CartView>) => void;
  onCheckedOut: () => Promise<void>;
  onNewCart: () => Promise<void>;
}) {
  const { cart } = props;
  const [coupon, setCoupon] = useState("");
  const [couponInfo, setCouponInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  // A ref, not state: it blocks a second click immediately, before React re-renders the disabled button.
  const inFlight = useRef(false);

  async function checkCoupon() {
    if (!coupon.trim()) return;
    try {
      const info = await api.checkCoupon(coupon.trim());
      setCouponInfo(info.status === "AVAILABLE" ? `${info.percentOff}% off · available` : "Already redeemed");
    } catch (e) {
      setCouponInfo(e instanceof ApiError ? e.message : "Could not check coupon");
    }
  }

  /**
   * Sends the checkout. If the network fails before a response arrives, it retries with the SAME
   * Idempotency-Key, so the server returns the original order instead of creating a second one.
   */
  async function send(attempt: Attempt): Promise<Order> {
    for (let tryNo = 0; ; tryNo++) {
      try {
        return (await api.checkout(attempt.cartId, attempt.key, attempt.couponCode, attempt.expectedSubtotalCents)).data;
      } catch (e) {
        const networkError = !(e instanceof ApiError);
        // Safe to repeat with the same key (nothing was written): the first attempt is still running, or the server was busy (503).
        const safeToRepeat = e instanceof ApiError && (e.code === "REQUEST_IN_PROGRESS" || e.code === "SERVER_BUSY");
        if ((networkError || safeToRepeat) && tryNo < NETWORK_RETRIES) {
          await new Promise((r) => setTimeout(r, 800 * (tryNo + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  async function checkout() {
    if (!cart || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    // One key per checkout. Any automatic retry of this checkout reuses it.
    const attempt: Attempt = {
      cartId: cart.id,
      key: crypto.randomUUID(),
      couponCode: coupon.trim() || undefined,
      expectedSubtotalCents: cart.subtotalCents,
    };
    try {
      const placed = await send(attempt);
      setOrder(placed);
      rememberOrder(placed.id);
      props.notify(`Order #${placed.id.slice(0, 8)} placed`);
      setCoupon("");
      setCouponInfo(null);
      // The old cart is now CHECKED_OUT; start an empty one so the shop shows 0 in cart.
      await Promise.all([props.onCheckedOut(), props.onNewCart()]);
    } catch (e) {
      if (e instanceof ApiError && e.code === "PRICE_CHANGED") {
        // An admin changed a price after this page loaded: show the new prices and let the customer confirm.
        props.onChange(() => api.getCart(attempt.cartId));
        await props.onCheckedOut();
        props.notify("Prices changed since you opened the page. Review the new total and check out again.", "error");
      } else {
        props.notify(e instanceof ApiError ? `${e.code}: ${e.message}` : "Checkout failed. Check your connection and try again.", "error");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (order) {
    return (
      <aside className="card panel receipt">
        <div className="section-head">
          <h3 className="panel-title">Order placed</h3>
          <span className="pill ok">Paid</span>
        </div>
        <p className="muted mono">#{order.id}</p>
        <ul className="lines">
          {order.lines.map((line) => (
            <li key={line.productId}>
              <span>
                {line.quantity} × {line.name}
                <small className="muted"> @ {money(line.unitPriceCents)}</small>
              </span>
              <span>{money(line.lineTotalCents)}</span>
            </li>
          ))}
        </ul>
        <dl className="totals">
          <dt>Subtotal</dt>
          <dd>{money(order.subtotalCents)}</dd>
          <dt>Discount {order.coupon && <small className="mono">({order.coupon.code}, {order.coupon.percentOff}%)</small>}</dt>
          <dd>−{money(order.discountCents)}</dd>
          <dt className="grand">Total</dt>
          <dd className="grand">{money(order.totalCents)}</dd>
        </dl>
        <p className="muted small-print">Saved to "Your orders" below.</p>
        <button className="btn primary wide" onClick={() => setOrder(null)}>
          Continue shopping
        </button>
      </aside>
    );
  }

  return (
    <aside className="card panel">
      <div className="section-head">
        <h3 className="panel-title">Your cart</h3>
        <span className="muted">{cart?.itemCount ?? 0} items</span>
      </div>

      {!cart || cart.items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z" />
              <path d="M9 10V7a3 3 0 0 1 6 0v3" />
            </svg>
          </span>
          <strong>Your cart is empty</strong>
          <p className="muted">Pick something from the collection and it will show up here.</p>
          <button
            className="btn ghost small"
            onClick={() => document.getElementById("collection")?.scrollIntoView({ behavior: "smooth" })}
          >
            Browse products
          </button>
        </div>
      ) : (
        <ul className="lines">
          {cart.items.map((item) => (
            <li key={item.productId}>
              <div>
                <div>{item.name}</div>
                <small className="muted">{money(item.unitPriceCents)} each</small>
                {!item.inStock && <small className="warn"> · only {item.availableInventory} left</small>}
              </div>
              <div className="qty">
                <button
                  aria-label={`Decrease ${item.name}`}
                  onClick={() =>
                    props.onChange(() =>
                      item.quantity > 1
                        ? api.setQuantity(cart.id, item.productId, item.quantity - 1)
                        : api.removeItem(cart.id, item.productId),
                    )
                  }
                >
                  −
                </button>
                <span>{item.quantity}</span>
                <button
                  aria-label={`Increase ${item.name}`}
                  onClick={() => props.onChange(() => api.setQuantity(cart.id, item.productId, item.quantity + 1))}
                >
                  +
                </button>
              </div>
              <span className="line-total">{money(item.lineTotalCents)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="coupon">
        <label htmlFor="coupon">Coupon code</label>
        <div className="row">
          <input
            id="coupon"
            placeholder="SAVE10-XXXXXX"
            value={coupon}
            onChange={(e) => {
              setCoupon(e.target.value.toUpperCase());
              setCouponInfo(null);
            }}
          />
          <button className="btn ghost small" onClick={checkCoupon}>
            Check
          </button>
        </div>
        {couponInfo && <small className="muted">{couponInfo}</small>}
      </div>

      <dl className="totals">
        <dt className="grand">Subtotal</dt>
        <dd className="grand">{money(cart?.subtotalCents ?? 0)}</dd>
      </dl>
      <p className="muted small-print">Prices update live. You pay the price shown at checkout; any discount is applied then.</p>
      <button className="btn primary wide" disabled={!cart || cart.items.length === 0 || busy} onClick={checkout}>
        {busy ? "Processing payment…" : "Checkout"}
      </button>
    </aside>
  );
}
