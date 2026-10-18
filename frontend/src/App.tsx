import { useCallback, useEffect, useState } from "react";
import { Admin } from "./Admin";
import { ApiError, api, type CartView, type Product } from "./api";
import { CartPanel } from "./CartPanel";
import { Shop } from "./Shop";

type Tab = "shop" | "admin";
export type Notify = (message: string, tone?: "ok" | "error") => void;

const CART_KEY = "ublinox.cartId";

export function App() {
  const [tab, setTab] = useState<Tab>("shop");
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartView | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [offline, setOffline] = useState(false);

  const notify: Notify = useCallback((message, tone = "ok") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 3800);
  }, []);

  const refreshProducts = useCallback(() => api.products().then(setProducts), []);

  const startNewCart = useCallback(async () => {
    const fresh = await api.createCart();
    localStorage.setItem(CART_KEY, fresh.id);
    setCart(fresh);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await refreshProducts();
        const saved = localStorage.getItem(CART_KEY);
        const existing = saved ? await api.getCart(saved).catch(() => null) : null;
        if (existing && existing.status === "OPEN") setCart(existing);
        else await startNewCart();
      } catch {
        setOffline(true);
      }
    })();
  }, [refreshProducts, startNewCart]);

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

  return (
    <div className="page">
      <header className="hero">
        <div className="hero-inner">
          <div className="brand">
            <span className="logo">u</span>
            <div>
              <h1>Ublinox Store</h1>
              <p>Order milestones unlock coupons. Checkout is safe to retry.</p>
            </div>
          </div>
          <nav className="tabs" aria-label="Sections">
            <button className={tab === "shop" ? "active" : ""} onClick={() => setTab("shop")}>
              Shop
            </button>
            <button className={tab === "admin" ? "active" : ""} onClick={() => setTab("admin")}>
              Admin
            </button>
          </nav>
        </div>
      </header>

      {offline && (
        <div className="banner error">
          The API is not reachable. Start the backend with <code>cd backend && npm start</code>, then reload.
        </div>
      )}

      <main className="content">
        {tab === "shop" ? (
          <div className="shop-layout">
            <Shop
              products={products}
              cart={cart}
              onAdd={(productId, quantity) => cart && updateCart(() => api.setQuantity(cart.id, productId, quantity))}
            />
            <CartPanel
              cart={cart}
              notify={notify}
              onChange={updateCart}
              onCheckedOut={async () => {
                await refreshProducts();
              }}
              onNewCart={startNewCart}
            />
          </div>
        ) : (
          <Admin products={products} notify={notify} onProductsChanged={refreshProducts} />
        )}
      </main>

      {toast && <div className={`toast ${toast.tone}`}>{toast.message}</div>}
    </div>
  );
}
