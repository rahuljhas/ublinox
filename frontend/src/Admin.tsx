import { useCallback, useEffect, useState } from "react";
import type { Notify } from "./App";
import { ApiError, api, money, type Coupon, type Product, type Report } from "./api";
import { AdminOrderHistory } from "./OrderHistory";

export function Admin(props: { products: Product[]; notify: Notify; onProductsChanged: () => Promise<void> }) {
  const [report, setReport] = useState<Report | null>(null);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [latest, setLatest] = useState<Coupon | null>(null);
  const [race, setRace] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [r, c] = await Promise.all([api.admin.report(), api.admin.coupons()]);
    setReport(r);
    setCoupons(c);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fail = (e: unknown) => props.notify(e instanceof ApiError ? `${e.code}: ${e.message}` : "Request failed", "error");

  async function generate() {
    try {
      const coupon = await api.admin.generateCoupon();
      setLatest(coupon);
      props.notify(`Coupon ${coupon.code} generated`);
      await refresh();
    } catch (e) {
      fail(e);
    }
  }

  async function editProduct(product: Product, field: "priceCents" | "inventory", raw: string) {
    const value = field === "priceCents" ? Math.round(Number(raw) * 100) : Number(raw);
    if (!Number.isFinite(value) || value === product[field]) return;
    try {
      await api.admin.updateProduct(product.id, { [field]: value });
      await props.onProductsChanged();
      props.notify(`${product.name} updated`);
    } catch (e) {
      fail(e);
    }
  }

  /** Fires N checkouts at once for a scarce product to show the server never oversells. */
  async function raceForLastUnits() {
    const target = props.products.find((p) => p.id === "p-print") ?? props.products[0];
    if (!target) return;
    const contenders = 6;
    setRace(`Creating ${contenders} carts…`);
    const carts = await Promise.all(Array.from({ length: contenders }, () => api.createCart()));
    await Promise.all(carts.map((c) => api.setQuantity(c.id, target.id, 1).catch(() => null)));
    const results = await Promise.allSettled(carts.map((c) => api.checkout(c.id, crypto.randomUUID())));
    const won = results.filter((r) => r.status === "fulfilled").length;
    const codes = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason instanceof ApiError ? r.reason.code : "ERROR"));
    setRace(
      `${contenders} simultaneous checkouts for "${target.name}" (stock ${target.inventory}): ` +
        `${won} succeeded, ${codes.length} rejected${codes.length ? ` (${[...new Set(codes)].join(", ")})` : ""}.`,
    );
    await Promise.all([props.onProductsChanged(), refresh()]);
  }

  return (
    <div className="admin">
      <div className="section-head">
        <h2>Admin</h2>
        <button className="btn ghost small" onClick={refresh}>
          Refresh
        </button>
      </div>

      {report && (
        <div className="stats">
          <Stat label="Orders placed" value={String(report.ordersPlaced)} />
          <Stat label="Gross revenue" value={money(report.grossRevenueCents)} />
          <Stat label="Discounts granted" value={money(report.totalDiscountCents)} />
          <Stat label="Net revenue" value={money(report.netRevenueCents)} accent />
        </div>
      )}

      <div className="admin-grid">
        <section className="card panel">
          <div className="section-head">
            <h3>Coupons</h3>
            {report && (
              <span className="muted">
                every {report.couponRule.everyNOrders} orders · {report.couponRule.percentOff}% off
              </span>
            )}
          </div>
          {report && (
            <div className="chips">
              <span className="pill">{report.coupons.generated} generated</span>
              <span className="pill ok">{report.coupons.available} available</span>
              <span className="pill">{report.coupons.redeemed} redeemed</span>
              <span className={`pill ${report.couponRule.eligibleUnrewardedMilestones > 0 ? "low" : ""}`}>
                {report.couponRule.eligibleUnrewardedMilestones} milestone(s) waiting
              </span>
            </div>
          )}
          <button className="btn primary" onClick={generate}>
            Generate coupon
          </button>
          {latest && (
            <div className="banner ok">
              New coupon <code className="mono">{latest.code}</code> for milestone {latest.milestone} (order #{latest.unlockedAtOrderCount}).
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Milestone</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {coupons.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    No coupons yet.
                  </td>
                </tr>
              )}
              {coupons.map((c) => (
                <tr key={c.code}>
                  <td className="mono">{c.code}</td>
                  <td>
                    #{c.milestone} · order {c.unlockedAtOrderCount}
                  </td>
                  <td>
                    <span className={`pill ${c.status === "AVAILABLE" ? "ok" : ""}`}>{c.status.toLowerCase()}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card panel">
          <h3>Sold by product</h3>
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Qty</th>
                <th className="num">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {(report?.productsSold.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    No sales yet.
                  </td>
                </tr>
              )}
              {report?.productsSold.map((row) => (
                <tr key={row.productId}>
                  <td>{row.name}</td>
                  <td className="num">{row.quantity}</td>
                  <td className="num">{money(row.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card panel">
          <h3>Catalog</h3>
          <p className="muted small-print">Change a price or stock level, then look at an open cart: it shows the new price.</p>
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Price ($)</th>
                <th className="num">Stock</th>
              </tr>
            </thead>
            <tbody>
              {props.products.map((p) => (
                <tr key={`${p.id}-${p.priceCents}-${p.inventory}`}>
                  <td>{p.name}</td>
                  <td className="num">
                    <input
                      aria-label={`${p.name} price`}
                      defaultValue={(p.priceCents / 100).toFixed(2)}
                      onBlur={(e) => editProduct(p, "priceCents", e.target.value)}
                    />
                  </td>
                  <td className="num">
                    <input
                      aria-label={`${p.name} stock`}
                      defaultValue={p.inventory}
                      onBlur={(e) => editProduct(p, "inventory", e.target.value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <div className="span-2">
          <AdminOrderHistory refreshKey={coupons.length + (report?.ordersPlaced ?? 0)} />
        </div>

        <section className="card panel">
          <h3>Concurrency demo</h3>
          <p className="muted small-print">
            Sends 6 checkouts at the same moment for the limited print. Only as many as are in stock can succeed.
          </p>
          <button className="btn primary" onClick={raceForLastUnits}>
            Race for the last units
          </button>
          {race && <div className="banner ok">{race}</div>}
        </section>
      </div>
    </div>
  );
}

function Stat(props: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`card stat ${props.accent ? "accent" : ""}`}>
      <span className="muted">{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
