import { useCallback, useEffect, useState } from "react";
import { Admin } from "./Admin";
import { ApiError, api, type CartView, type Product, type Report } from "./api";
import { CartPanel } from "./CartPanel";
import { Logo } from "./Logo";
import { Shop } from "./Shop";

type Tab = "shop" | "admin";
export type Notify = (message: string, tone?: "ok" | "error") => void;

const CART_KEY = "ublinox.cartId";

export function App() {
  const [tab, setTab] = useState<Tab>("shop");
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartView | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [offline, setOffline] = useState(false);

  const notify: Notify = useCallback((message, tone = "ok") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 3800);
  }, []);

  const refreshProducts = useCallback(() => api.products().then(setProducts), []);
  const refreshReport = useCallback(() => api.admin.report().then(setReport).catch(() => undefined), []);

  const startNewCart = useCallback(async () => {
    const fresh = await api.createCart();
    localStorage.setItem(CART_KEY, fresh.id);
    setCart(fresh);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([refreshProducts(), refreshReport()]);
        const saved = localStorage.getItem(CART_KEY);
        const existing = saved ? await api.getCart(saved).catch(() => null) : null;
        if (existing && existing.status === "OPEN") setCart(existing);
        else await startNewCart();
      } catch {
        setOffline(true);
      }
    })();
  }, [refreshProducts, refreshReport, startNewCart]);

  const updateCart = useCallback(
    async (action: () => Promise<CartView>) => {
      try {
        setCart(await action());
      } catch (e) {
        notify(e instanceof ApiError ? `${e.code}: ${e.message}` : "Request failed", "error");
      }
    },
    [notify],
  );

  const goTo = (target: Tab, anchor?: string) => {
    setTab(target);
    if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth" }));
  };

  return (
    <div className="page">
      <nav className="topbar">
        <div className="topbar-inner">
          <button className="brand-button" onClick={() => goTo("shop")} aria-label="Ublinox home">
            <Logo />
          </button>
          <div className="nav-links">
            <button className={tab === "shop" ? "active" : ""} onClick={() => goTo("shop", "collection")}>
              Shop
            </button>
            <button onClick={() => goTo("shop", "how-it-works")}>How it works</button>
            <button className={tab === "admin" ? "active" : ""} onClick={() => goTo("admin")}>
              Admin
            </button>
          </div>
          <button className="cart-chip" onClick={() => goTo("shop", "cart")} aria-label="Go to cart">
            Cart <span className="badge">{cart?.itemCount ?? 0}</span>
          </button>
        </div>
      </nav>

      {offline && (
        <div className="banner error">
          The API is not reachable. Start the backend with <code>cd backend && npm start</code>, then reload.
        </div>
      )}

      {tab === "shop" ? (
        <>
          <Hero report={report} onShop={() => goTo("shop", "collection")} onLearn={() => goTo("shop", "how-it-works")} />
          <HowItWorks report={report} />
          <section className="section" id="collection">
            <div className="section-intro">
              <span className="eyebrow">The collection</span>
              <h2>Everyday desk essentials</h2>
              <p className="muted">Stock updates live. Limited pieces are marked, and checkout never sells more than we have.</p>
            </div>
            <div className="shop-layout">
              <Shop
                products={products}
                cart={cart}
                onAdd={(productId, quantity) => cart && updateCart(() => api.setQuantity(cart.id, productId, quantity))}
              />
              <div id="cart">
                <CartPanel
                  cart={cart}
                  notify={notify}
                  onChange={updateCart}
                  onCheckedOut={async () => {
                    await Promise.all([refreshProducts(), refreshReport()]);
                  }}
                  onNewCart={startNewCart}
                />
              </div>
            </div>
          </section>
        </>
      ) : (
        <section className="section">
          <div className="section-intro">
            <span className="eyebrow">Store admin</span>
            <h2>Sales, rewards and catalog</h2>
            <p className="muted">Admin endpoints live under /admin. There is no login in this demo.</p>
          </div>
          <Admin
            products={products}
            notify={notify}
            onProductsChanged={async () => {
              await Promise.all([refreshProducts(), refreshReport()]);
            }}
          />
        </section>
      )}

      <footer className="footer">
        <div className="footer-inner">
          <Logo />
          <p className="muted">Checkout &amp; Rewards Service demo · Node.js + TypeScript API · in-memory store</p>
        </div>
      </footer>

      {toast && <div className={`toast ${toast.tone}`}>{toast.message}</div>}
    </div>
  );
}

function Hero(props: { report: Report | null; onShop: () => void; onLearn: () => void }) {
  const rule = props.report?.couponRule;
  const placed = props.report?.ordersPlaced ?? 0;
  const n = rule?.everyNOrders ?? 5;
  const progress = placed % n;
  const toGo = n - progress;

  return (
    <header className="hero">
      <div className="hero-inner">
        <div className="hero-copy">
          <span className="eyebrow">Stationery &amp; desk goods</span>
          <h1>
            Thoughtful things <br />
            for <span className="accent-text">your desk.</span>
          </h1>
          <p className="lede">
            Notebooks, pens, lamps and limited prints. Check out with confidence: a retried payment never charges you twice.
          </p>
          <div className="hero-actions">
            <button className="btn primary" onClick={props.onShop}>
              Shop the collection
            </button>
            <button className="btn ghost" onClick={props.onLearn}>
              How rewards work
            </button>
          </div>
        </div>

        <aside className="card reward-card" aria-label="Rewards progress">
          <span className="eyebrow">Store rewards</span>
          <h3>
            Every {n}th order unlocks <span className="accent-text">{rule?.percentOff ?? 10}% off</span>
          </h3>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={n} aria-valuenow={progress}>
            {Array.from({ length: n }, (_, i) => (
              <span key={i} className={i < progress ? "filled" : ""} />
            ))}
          </div>
          <p className="muted">
            {toGo === n && placed > 0
              ? "A milestone was just reached. The store can issue a coupon now."
              : `${toGo} more order${toGo === 1 ? "" : "s"} until the next coupon.`}
          </p>
          <dl className="reward-stats">
            <div>
              <dt>Orders placed</dt>
              <dd>{placed}</dd>
            </div>
            <div>
              <dt>Coupons issued</dt>
              <dd>{props.report?.coupons.generated ?? 0}</dd>
            </div>
            <div>
              <dt>Redeemed</dt>
              <dd>{props.report?.coupons.redeemed ?? 0}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </header>
  );
}

function HowItWorks(props: { report: Report | null }) {
  const n = props.report?.couponRule.everyNOrders ?? 5;
  const steps = [
    {
      title: "Build your cart",
      text: "Add items and change quantities. Prices and stock are always current, and you can't add more than we have.",
    },
    {
      title: "Check out safely",
      text: "Each checkout carries a unique key. If the connection drops and you retry, you get the same order, not a second charge.",
    },
    {
      title: "Unlock rewards",
      text: `Every ${n}th order in the store unlocks a one-time coupon. It can be used once, and never by two orders.`,
    },
  ];
  return (
    <section className="section how" id="how-it-works">
      <div className="section-intro">
        <span className="eyebrow">How it works</span>
        <h2>From cart to reward in three steps</h2>
      </div>
      <ol className="steps">
        {steps.map((step, i) => (
          <li key={step.title} className="card step">
            <span className="step-number">{i + 1}</span>
            <h3>{step.title}</h3>
            <p className="muted">{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
