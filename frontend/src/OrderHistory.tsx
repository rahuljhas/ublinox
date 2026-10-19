import { useCallback, useEffect, useState } from "react";
import { api, money, type Order, type OrderPage } from "./api";

const MY_ORDERS_KEY = "ublinox.myOrders";
const PAGE_SIZE = 10;

/** No login in this demo, so "my orders" are the order ids this browser placed. */
export function rememberOrder(orderId: string) {
  try {
    const ids: string[] = JSON.parse(localStorage.getItem(MY_ORDERS_KEY) ?? "[]");
    if (!ids.includes(orderId)) localStorage.setItem(MY_ORDERS_KEY, JSON.stringify([orderId, ...ids].slice(0, 50)));
  } catch {
    /* storage unavailable: history is a convenience only */
  }
}

function myOrderIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MY_ORDERS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Customer view: orders placed from this browser, fetched one by one with GET /orders/{id}. */
export function MyOrders({ refreshKey }: { refreshKey: number }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    // Orders that no longer exist (server restarted) are skipped.
    Promise.all(myOrderIds().map((id) => api.getOrder(id).catch(() => null))).then((list) =>
      setOrders(list.filter((o): o is Order => o !== null)),
    );
  }, [refreshKey]);

  if (orders.length === 0) return null;

  return (
    <section className="section" id="my-orders">
      <div className="section-intro">
        <span className="eyebrow">Order history</span>
        <h2>Your orders</h2>
        <p className="muted">Orders placed from this browser. Each keeps the prices you paid, even if they change later.</p>
      </div>
      <div className="card history">
        {orders.map((order) => (
          <div key={order.id} className="history-row">
            <button className="history-head" onClick={() => setOpen(open === order.id ? null : order.id)} aria-expanded={open === order.id}>
              <span className="mono">#{order.id.slice(0, 8)}</span>
              <span className="muted">{when(order.createdAt)}</span>
              <span>{order.lines.reduce((s, l) => s + l.quantity, 0)} items</span>
              {order.coupon ? <span className="pill ok">{order.coupon.code}</span> : <span />}
              <strong>{money(order.totalCents)}</strong>
              <span className="chev">{open === order.id ? "−" : "+"}</span>
            </button>
            {open === order.id && (
              <div className="history-detail">
                <ul className="lines">
                  {order.lines.map((line) => (
                    <li key={line.productId}>
                      <span>
                        {line.quantity} × {line.name} <small className="muted">@ {money(line.unitPriceCents)}</small>
                      </span>
                      <span>{money(line.lineTotalCents)}</span>
                    </li>
                  ))}
                </ul>
                <dl className="totals">
                  <dt>Subtotal</dt>
                  <dd>{money(order.subtotalCents)}</dd>
                  <dt>Discount</dt>
                  <dd>−{money(order.discountCents)}</dd>
                  <dt className="grand">Total</dt>
                  <dd className="grand">{money(order.totalCents)}</dd>
                </dl>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Admin view: every order, newest first, from GET /admin/orders. */
export function AdminOrderHistory({ refreshKey }: { refreshKey: number }) {
  const [page, setPage] = useState<OrderPage | null>(null);
  const [offset, setOffset] = useState(0);

  const load = useCallback(() => api.admin.orders(PAGE_SIZE, offset).then(setPage), [offset]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const from = page && page.total > 0 ? offset + 1 : 0;
  const to = page ? Math.min(offset + PAGE_SIZE, page.total) : 0;

  return (
    <section className="card panel">
      <div className="section-head">
        <h3>Order history</h3>
        <span className="muted">
          {from}–{to} of {page?.total ?? 0}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Placed</th>
            <th className="num">Items</th>
            <th>Coupon</th>
            <th className="num">Subtotal</th>
            <th className="num">Discount</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {page?.orders.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No orders yet.
              </td>
            </tr>
          )}
          {page?.orders.map((o) => (
            <tr key={o.id}>
              <td className="mono">#{o.id.slice(0, 8)}</td>
              <td>{when(o.createdAt)}</td>
              <td className="num">{o.itemCount}</td>
              <td className="mono">{o.couponCode ?? "–"}</td>
              <td className="num">{money(o.subtotalCents)}</td>
              <td className="num">{o.discountCents ? `−${money(o.discountCents)}` : "–"}</td>
              <td className="num">
                <strong>{money(o.totalCents)}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="btn ghost small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          ← Newer
        </button>
        <button className="btn ghost small" disabled={!page || to >= page.total} onClick={() => setOffset(offset + PAGE_SIZE)}>
          Older →
        </button>
      </div>
    </section>
  );
}
