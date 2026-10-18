import { useState } from "react";
import type { Notify } from "./App";
import { ApiError, api, money, type CartView, type Order } from "./api";

interface LastAttempt {
  cartId: string;
  key: string;
  couponCode?: string;
}

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
  const [replayNote, setReplayNote] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<LastAttempt | null>(null);

  async function checkCoupon() {
    if (!coupon.trim()) return;
    try {
      const info = await api.checkCoupon(coupon.trim());
      setCouponInfo(info.status === "AVAILABLE" ? `${info.percentOff}% off · available` : "Already redeemed");
    } catch (e) {
      setCouponInfo(e instanceof ApiError ? e.message : "Could not check coupon");
    }
  }

  async function send(attempt: LastAttempt, isRetry: boolean) {
    setBusy(true);
    try {
      const { data, replayed } = await api.checkout(attempt.cartId, attempt.key, attempt.couponCode);
      setOrder(data);
      setReplayNote(
        replayed
          ? `Replayed: the server returned the same order #${data.id.slice(0, 8)}. No new order, no stock charged twice.`
          : null,
      );
      if (!isRetry) props.notify(`Order #${data.id.slice(0, 8)} placed`);
      await props.onCheckedOut();
    } catch (e) {
      props.notify(e instanceof ApiError ? `${e.code}: ${e.message}` : "Checkout failed", "error");
    } finally {
      setBusy(false);
    }
  }

  function checkout() {
    if (!cart) return;
    // A new key per checkout attempt. Retrying reuses it, so the server can recognise the duplicate.
    const attempt = { cartId: cart.id, key: crypto.randomUUID(), couponCode: coupon.trim() || undefined };
    setLastAttempt(attempt);
    void send(attempt, false);
  }

  if (order) {
    return (
      <aside className="card panel receipt">
        <div className="section-head">
          <h2>Order placed</h2>
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
        {replayNote && <div className="banner ok">{replayNote}</div>}
        <div className="stack">
          <button className="btn ghost" disabled={busy || !lastAttempt} onClick={() => lastAttempt && send(lastAttempt, true)}>
            Send the same checkout again (same Idempotency-Key)
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              setOrder(null);
              setReplayNote(null);
              setCoupon("");
              setCouponInfo(null);
              await props.onNewCart();
            }}
          >
            Start a new cart
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="card panel">
      <div className="section-head">
        <h2>Your cart</h2>
        <span className="muted">{cart?.itemCount ?? 0} items</span>
      </div>

      {!cart || cart.items.length === 0 ? (
        <p className="empty">Your cart is empty. Add something you like.</p>
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
