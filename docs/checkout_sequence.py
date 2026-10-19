"""Renders docs/checkout-sequence.png — UML sequence diagram of POST /carts/{id}/checkout."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle, FancyArrowPatch

plt.rcParams["font.family"] = ["Helvetica", "Arial", "DejaVu Sans"]

W, H = 28, 31
fig = plt.figure(figsize=(W, H), dpi=120)
ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, W); ax.set_ylim(0, H); ax.axis("off")
fig.patch.set_facecolor("white")

INK, MUTED, GRID = "#16202B", "#5A6878", "#C9D1DA"
OK, ERR, ALT = "#2E7D32", "#C62828", "#6A1B9A"

actors = [
    ("Client", "customer app", "#232F3E"),
    ("HTTP layer", "Express + zod", "#1F4E9E"),
    ("CheckoutService", "orchestrates", "#6A1B9A"),
    ("IdempotencyRegistry", "key → response", "#C62828"),
    ("LockManager", "per-key mutex", "#C62828"),
    ("FakePaymentGateway", "async", "#ED7100"),
    ("In-memory store", "Maps", "#37474F"),
]
X = [1.9 + i * 4.0 for i in range(len(actors))]
TOP, BOTTOM = 27.6, 4.6

# ---------------- title ----------------
ax.text(0.6, H - 0.7, "Checkout — Sequence Diagram", fontsize=28, weight="bold", color=INK, va="center")
ax.text(0.6, H - 1.3, "POST /carts/{id}/checkout   ·   header Idempotency-Key: K   ·   body { couponCode? }",
        fontsize=14, color=MUTED, va="center", family="monospace")

# ---------------- lifelines ----------------
for (name, sub, col), x in zip(actors, X):
    ax.add_patch(FancyBboxPatch((x - 1.65, TOP), 3.3, 1.0, boxstyle="round,pad=0,rounding_size=0.1",
                                facecolor=col, edgecolor=col, zorder=3))
    ax.text(x, TOP + 0.62, name, color="white", fontsize=12.5, weight="bold", ha="center", va="center", zorder=4)
    ax.text(x, TOP + 0.3, sub, color="white", fontsize=10, ha="center", va="center", zorder=4)
    ax.plot([x, x], [BOTTOM, TOP], color=GRID, lw=1.4, ls=(0, (6, 4)), zorder=0)


def activation(i, y1, y2):
    ax.add_patch(Rectangle((X[i] - 0.11, y2), 0.22, y1 - y2, facecolor="white", edgecolor=actors[i][2], lw=1.4, zorder=2))


def msg(i, j, y, text, n=None, ret=False, color=INK, above=True):
    x1, x2 = X[i] + (0.11 if j > i else -0.11), X[j] + (-0.11 if j > i else 0.11)
    ax.add_patch(FancyArrowPatch((x1, y), (x2, y), arrowstyle="-|>" if not ret else "->", mutation_scale=16,
                                 color=color, lw=1.8, linestyle="--" if ret else "-", zorder=5))
    label = f"{n}. {text}" if n else text
    ax.text((x1 + x2) / 2, y + (0.17 if above else -0.22), label, color=color, fontsize=11.2, ha="center",
            va="bottom" if above else "top", zorder=6, weight="bold" if n else "normal")


def self_msg(i, y, text, n=None, color=INK, h=0.45):
    x = X[i] + 0.11
    ax.plot([x, x + 0.6, x + 0.6], [y, y, y - h], color=color, lw=1.8, zorder=5)
    ax.add_patch(FancyArrowPatch((x + 0.6, y - h), (x, y - h), arrowstyle="-|>", mutation_scale=14, color=color, lw=1.8, zorder=5))
    ax.text(x + 0.75, y - h / 2, f"{n}. {text}" if n else text, color=color, fontsize=11.2, va="center", zorder=6,
            weight="bold" if n else "normal")


def frame(x1, x2, ytop, ybot, kind, guards):
    ax.add_patch(Rectangle((x1, ybot), x2 - x1, ytop - ybot, facecolor="none", edgecolor=ALT, lw=1.6, zorder=1))
    ax.add_patch(Rectangle((x1, ytop - 0.42), 0.75, 0.42, facecolor=ALT, edgecolor=ALT, zorder=1))
    ax.text(x1 + 0.375, ytop - 0.21, kind, color="white", fontsize=11, weight="bold", ha="center", va="center", zorder=2)
    for k, (y, g) in enumerate(guards):
        if k:
            ax.plot([x1, x2], [y, y], color=ALT, lw=1.2, ls=(0, (5, 4)), zorder=1)
        ax.text(x1 + (0.9 if k == 0 else 0.15), y - 0.21, g, color=ALT, fontsize=11, weight="bold", va="center", zorder=2)


C, HT, SV, ID, LK, PY, ST = range(7)

# ---------------- 1-2 request + validation ----------------
y = 27.0
activation(HT, y, 4.9)
msg(C, HT, y, "POST /carts/{id}/checkout  (Idempotency-Key: K)", 1)
self_msg(HT, y - 0.45, "validate header + body (zod)", 2)
frame(X[C] - 1.2, X[SV] + 0.5, 25.75, 24.6, "alt", [(25.75, "[ header missing or body invalid ]")])
msg(HT, C, 24.95, "400 VALIDATION_ERROR { code, message, details }", ret=True, color=ERR)

# ---------------- 3-4 idempotency ----------------
y = 24.1
msg(HT, SV, y, "checkout(cartId, K, couponCode)", 3)
activation(SV, y, 5.6)
msg(SV, ID, y - 0.75, "begin(K, hash(cartId + body))", 4)
frame(X[C] - 1.2, X[ID] + 1.9, 22.85, 19.5, "alt", [
    (22.85, "[ K completed, same request ]"), (21.7, "[ K still IN_PROGRESS ]"), (20.6, "[ K reused with a different body ]")])
msg(ID, SV, 22.35, "stored 201 response", ret=True, color=OK)
msg(SV, C, 21.9, "201 same order again  (no new order, no stock change)", ret=True, color=OK)
msg(SV, C, 20.95, "409 REQUEST_IN_PROGRESS", ret=True, color=ERR)
msg(SV, C, 19.85, "422 IDEMPOTENCY_KEY_REUSED", ret=True, color=ERR)
ax.text(X[ID] + 0.25, 19.15, "[ new K ]  record K = IN_PROGRESS, continue", color=ALT, fontsize=11, weight="bold", va="center")

# ---------------- 5-7 lock, read, validate ----------------
y = 18.5
msg(SV, LK, y, "acquire(cart:id, product:* sorted, coupon:code)", 5)
activation(LK, y, 6.35)
ax.text(X[LK] + 0.25, y - 0.4, "sorted order → no deadlock", color=MUTED, fontsize=10.5, va="center")
msg(LK, SV, y - 0.85, "locks held", ret=True)
msg(SV, ST, y - 1.6, "read cart, products, coupon", 6)
msg(ST, SV, y - 2.2, "current values", ret=True)
self_msg(SV, y - 2.7, "check rules + price in integer cents", 7, h=0.5)
ax.text(X[SV] + 0.85, y - 3.55, "cart OPEN & not empty · stock ≥ qty for every line · coupon AVAILABLE · subtotal = expectedSubtotalCents (if sent)\n"
        "subtotal = Σ unit_price × qty · discount = round_half_up(subtotal × x / 100) · total = max(0, subtotal − discount)",
        color=MUTED, fontsize=10.3, va="center", linespacing=1.5)
frame(X[C] - 1.2, X[ID] + 1.9, 14.2, 12.7, "alt", [(14.2, "[ a rule fails ]")])
msg(SV, ID, 13.75, "release(K)  (client may fix cart and retry)", ret=True, color=ERR)
msg(SV, C, 13.0, "409 INSUFFICIENT_INVENTORY · CART_ALREADY_CHECKED_OUT\n409 COUPON_ALREADY_REDEEMED · PRICE_CHANGED · 404 COUPON_NOT_FOUND · 422 CART_EMPTY",
    ret=True, color=ERR)

# ---------------- 8 payment ----------------
y = 12.1
msg(SV, PY, y, "await charge(totalCents)", 8)
activation(PY, y, y - 0.65)
msg(PY, SV, y - 0.65, "approved", ret=True, color=OK)
frame(X[C] - 1.2, X[PY] + 1.9, 11.05, 9.95, "alt", [(11.05, "[ payment declined ]")])
msg(SV, C, 10.35, "402 PAYMENT_DECLINED  (nothing written, locks released, K released)", ret=True, color=ERR)

# ---------------- 9 commit ----------------
y = 9.4
ax.add_patch(Rectangle((X[SV] - 0.4, 6.95), X[ST] - X[SV] + 2.0, 2.85, facecolor="#E8F5E9", edgecolor=OK, lw=1.8, zorder=0))
ax.text(X[SV] - 0.25, 9.6, "ATOMIC COMMIT  — synchronous, no await, so no other request can interleave", color=OK,
        fontsize=11.5, weight="bold", va="center")
msg(SV, ST, y - 0.6, "commit()", 9)
ax.text(X[ST] - 3.6, 8.5, "stock −= qty for each line\ncoupon → REDEEMED\norder + line snapshot (name, unit price, qty)\n"
        "cart → CHECKED_OUT  ·  placedOrders += 1", color=INK, fontsize=10.8, va="top", linespacing=1.45)
msg(SV, ID, 7.25, "complete(K, 201 response)", 10)

# ---------------- 11-12 release + respond ----------------
msg(SV, LK, 6.6, "release all locks  (finally)", 11)
msg(SV, HT, 5.85, "order", ret=True, color=OK)
msg(HT, C, 5.15, "201 Created { orderId, lines, subtotal, discount, total }", 12, ret=True, color=OK)

# ---------------- footer: why it is safe ----------------
rect_y = 0.5
ax.add_patch(FancyBboxPatch((0.6, rect_y), W - 1.2, 3.6, boxstyle="round,pad=0,rounding_size=0.12",
                            facecolor="#FAFBFC", edgecolor=GRID, lw=1.4))
ax.text(0.9, 3.75, "What this sequence guarantees", fontsize=14, weight="bold", color=INK, va="center")
rows = [
    ("Retry after timeout", "same K → step 4 replays the stored 201; no second order, no second stock decrement"),
    ("Two checkouts, same cart", "cart lock serialises them; the second sees CHECKED_OUT → 409"),
    ("Two carts, last unit", "product lock + stock re-checked under the lock (step 7); the loser gets 409 INSUFFICIENT_INVENTORY"),
    ("Two checkouts, same coupon", "coupon lock; the second sees REDEEMED → 409 COUPON_ALREADY_REDEEMED"),
    ("Failure anywhere before step 9", "nothing is written, so stock and coupon are never lost"),
]
for i, (k, v) in enumerate(rows):
    yy = 3.2 - i * 0.55
    ax.text(0.9, yy, k, fontsize=11.5, weight="bold", color=INK, va="center")
    ax.text(6.4, yy, v, fontsize=11.5, color=INK, va="center")

fig.savefig("checkout-sequence.png", dpi=120, facecolor="white")
print("ok")
