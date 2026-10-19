import { useCallback, useEffect, useState } from "react";
import { api, money, type Order, type OrderPage } from "./api";
import { customerName } from "./users";

const PAGE_SIZE = 10;

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Customer view: this customer's orders from GET /orders?customerId=, newest first. */
export function MyOrders({ customerId, name, refreshKey }: { customerId: string; name: string; refreshKey: number }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let current = true; // ignore a slow answer if the customer was switched meanwhile
    setOrders([]);
    setOpen(null);
    api.customerOrders(customerId).then((page) => current && setOrders(page.orders)).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [customerId, refreshKey]);

  return (
    <section className="section" id="my-orders">
      <div className="section-intro">
        <span className="eyebrow">Order history</span>
        <h2>Orders for {name}</h2>
        <p className="muted">Each order keeps the prices that were paid, even if they change later.</p>
      </div>
      <div className="card history">
        {orders.length === 0 && <p className="empty-history muted">No orders yet for {name}. Add something to the cart and check out.</p>}
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
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Placed</th>
            <th>Customer</th>
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
              <td colSpan={8} className="muted">
                No orders yet.
              </td>
            </tr>
          )}
          {page?.orders.map((o) => (
            <tr key={o.id}>
              <td className="mono">#{o.id.slice(0, 8)}</td>
              <td>{when(o.createdAt)}</td>
              <td>{customerName(o.customerId)}</td>
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
      </div>
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
