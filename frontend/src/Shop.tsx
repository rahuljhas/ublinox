import { money, type CartView, type Product } from "./api";

const TINTS = ["#ffd6e6", "#ffe3d6", "#f4dcff", "#ffdcef", "#ffe9f1", "#ffd1dc"];

export function Shop(props: { products: Product[]; cart: CartView | null; onAdd: (productId: string, quantity: number) => void }) {
  const inCart = (id: string) => props.cart?.items.find((item) => item.productId === id)?.quantity ?? 0;

  return (
    <section>
      <div className="section-head">
        <h2>Products</h2>
        <span className="muted">{props.products.length} items · prices in USD</span>
      </div>
      <div className="grid">
        {props.products.map((product, i) => {
          const qty = inCart(product.id);
          const soldOut = product.inventory === 0;
          return (
            <article className="card product" key={product.id}>
              <div className="art" style={{ background: `linear-gradient(140deg, #fff, ${TINTS[i % TINTS.length]})` }}>
                <span>{product.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
              </div>
              <div className="product-body">
                <h3>{product.name}</h3>
                <div className="row">
                  <strong className="price">{money(product.priceCents)}</strong>
                  <span className={`pill ${soldOut ? "out" : product.inventory <= 5 ? "low" : ""}`}>
                    {soldOut ? "Sold out" : product.inventory <= 5 ? `Only ${product.inventory} left` : `${product.inventory} in stock`}
                  </span>
                </div>
                <button
                  className="btn primary"
                  disabled={soldOut || !props.cart || qty >= product.inventory}
                  onClick={() => props.onAdd(product.id, qty + 1)}
                >
                  {qty > 0 ? `Add another (${qty} in cart)` : "Add to cart"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
