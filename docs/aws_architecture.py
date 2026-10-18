"""Renders docs/aws-architecture.png.

AWS deployment (one EC2 instance) and the layered structure of the single Node.js + TypeScript
process inside it. No database: all state lives in an in-memory store, as task.md allows.
"""
import glob
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from matplotlib.offsetbox import OffsetImage, AnnotationBbox

plt.rcParams["font.family"] = ["Helvetica", "Arial", "DejaVu Sans"]
RES = glob.glob("/tmp/ckvenv/lib/python3*/site-packages/resources/aws")[0]

W, H = 26, 17
fig = plt.figure(figsize=(W, H), dpi=140)
ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, W); ax.set_ylim(0, H); ax.axis("off")
fig.patch.set_facecolor("white")

INK, MUTED = "#16202B", "#5A6878"
AWS, REGION, EC2 = "#232F3E", "#00A4A6", "#ED7100"
L_HTTP, L_APP, L_DOM, L_CC, L_STORE = "#1F4E9E", "#6A1B9A", "#2E7D32", "#C62828", "#37474F"


def rect(x, y, w, h, edge, fill="none", lw=2, ls="-", r=0.12, z=1):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={r}",
                                facecolor=fill, edgecolor=edge, lw=lw, linestyle=ls, zorder=z))


def icon(path, x, y, zoom):
    ax.add_artist(AnnotationBbox(OffsetImage(plt.imread(path), zoom=zoom), (x, y), frameon=False, zorder=6))


def arrow(x1, y1, x2, y2, color=INK, lw=2, label=None, lx=0, ly=0.2):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=18, color=color, lw=lw, zorder=7))
    if label:
        ax.text((x1 + x2) / 2 + lx, (y1 + y2) / 2 + ly, label, color=color, fontsize=11, weight="bold",
                ha="center", zorder=8)


# ---------------- title ----------------
ax.text(0.6, H - 0.7, "Checkout & Rewards Service — Architecture", fontsize=28, weight="bold", color=INK, va="center")
ax.text(0.6, H - 1.3, "One Node.js + TypeScript process on one Amazon EC2 instance  ·  all state in memory  ·  "
        "layers call downward only", fontsize=14, color=MUTED, va="center")

# ---------------- clients ----------------
cx, cw = 0.6, 4.6
rect(cx, 10.3, cw, 4.4, INK, "#F5F7F9")
icon(f"{RES}/general/users.png", cx + 0.75, 14.0, 0.32)
ax.text(cx + 1.4, 14.0, "Customer client", fontsize=14, weight="bold", color=INK, va="center")
for i, t in enumerate(["POST   /carts", "GET    /carts/{id}", "PUT    /carts/{id}/items/{pid}",
                       "DELETE /carts/{id}/items/{pid}", "POST   /carts/{id}/checkout", "GET    /orders/{id}"]):
    ax.text(cx + 0.25, 13.2 - i * 0.45, t, fontsize=10.5, family="monospace", color=INK, va="center")

rect(cx, 6.9, cw, 2.9, "#DD344C", "#FDF0F1")
icon(f"{RES}/general/user.png", cx + 0.75, 9.1, 0.32)
ax.text(cx + 1.4, 9.1, "Administrator", fontsize=14, weight="bold", color="#DD344C", va="center")
for i, t in enumerate(["POST /admin/coupons", "GET  /admin/report", "(no auth; admin by route)"]):
    ax.text(cx + 0.25, 8.3 - i * 0.45, t, fontsize=10.5, family="monospace" if i < 2 else None, color=INK, va="center")

# notes under clients
rect(cx, 0.8, cw, 5.6, "#AAB7B8", "white", lw=1.4)
ax.text(cx + 0.25, 6.0, "Why exactly one instance", fontsize=13, weight="bold", color=INK, va="center")
notes = ["State lives in process memory.",
         "A second instance would hold its",
         "own stock and coupons → oversell.",
         "",
         "Restart = data reset (seed reloads).",
         "",
         "Scale-out path (DECISIONS.md):",
         "store → PostgreSQL, locks → DB",
         "row locks, then add instances."]
for i, t in enumerate(notes):
    ax.text(cx + 0.25, 5.45 - i * 0.48, t, fontsize=11, color=INK if t and not t.endswith(":") else MUTED, va="center",
            weight="bold" if t.endswith(":") else "normal")

# ---------------- AWS boundaries ----------------
ax0 = 6.0
rect(ax0, 0.8, W - ax0 - 0.4, 14.3, AWS, lw=2.2)
ax.text(ax0 + 0.25, 14.75, "AWS Cloud", fontsize=14, weight="bold", color=AWS, va="center")
rect(ax0 + 0.35, 1.1, W - ax0 - 1.1, 13.25, REGION, ls="--")
ax.text(ax0 + 0.6, 14.0, "Region: ap-south-1", fontsize=13, weight="bold", color=REGION, va="center")
ex = ax0 + 0.7
rect(ex, 1.4, W - ex - 1.05, 12.2, EC2, "#FFF8F1")
icon(f"{RES}/compute/ec2.png", ex + 0.55, 12.95, 0.2)
ax.text(ex + 1.15, 13.12, "Amazon EC2 instance", fontsize=14, weight="bold", color=EC2, va="center")
ax.text(ex + 1.15, 12.75, "1 instance · public IP · port 3000 open", fontsize=10.5, color=MUTED, va="center")

px, pw = ex + 0.35, W - ex - 1.75
rect(px, 1.7, pw, 10.6, INK, "white", lw=1.6)
ax.text(px + 0.25, 11.95, "Node.js process  ·  checkout-api (TypeScript)", fontsize=13.5, weight="bold", color=INK, va="center")

# ---------------- layers ----------------
layers = [
    ("1  HTTP layer", L_HTTP, ["Express router", "Request validation (zod)", "Idempotency-Key header", "Error middleware"],
     ["routes → handlers", "bad input → 400/422", "required on checkout", "{ code, message, details }"]),
    ("2  Application services", L_APP, ["CartService", "CheckoutService", "CouponService", "ReportService"],
     ["add · change · remove", "validate → pay → commit", "milestone check · generate", "read-only totals"]),
    ("3  Domain rules", L_DOM, ["Money", "Pricing & discount", "Coupon rule (n, x)", "State transitions"],
     ["integer cents only", "round half-up, total ≥ 0", "1 coupon per n orders", "cart OPEN → CHECKED_OUT"]),
    ("4  Concurrency & idempotency", L_CC, ["LockManager", "IdempotencyRegistry", "FakePaymentGateway", "Atomic commit"],
     ["per-key async mutex", "key → stored response", "async; always succeeds", "no await while writing"]),
    ("5  In-memory store", L_STORE, ["products", "carts", "orders", "coupons · keys"],
     ["Map<id, Product>", "Map<id, Cart>", "Map<id, Order> + lines", "Map<code, Coupon>"]),
]
lx0, lw_ = px + 0.3, pw - 0.6
lh, gap, ytop = 1.6, 0.42, 11.45
cell_w = (lw_ - 3.3 - 0.25 - 0.15 * 3) / 4
for i, (name, col, cells, subs) in enumerate(layers):
    y = ytop - (i + 1) * lh - i * gap
    rect(lx0, y, lw_, lh, col, col + "12", lw=1.8)
    ax.text(lx0 + 0.2, y + lh / 2, name, fontsize=12.5, weight="bold", color=col, va="center")
    for j, (c, s) in enumerate(zip(cells, subs)):
        x = lx0 + 3.3 + j * (cell_w + 0.15)
        rect(x, y + 0.2, cell_w, lh - 0.4, col, "white", lw=1.3, r=0.08, z=2)
        ax.text(x + cell_w / 2, y + lh / 2 + 0.2, c, fontsize=11.5, weight="bold", color=INK, ha="center", va="center", zorder=3)
        ax.text(x + cell_w / 2, y + lh / 2 - 0.2, s, fontsize=10, color=MUTED, ha="center", va="center", zorder=3)
    if i < len(layers) - 1:
        arrow(lx0 + 1.4, y - 0.02, lx0 + 1.4, y - gap + 0.02, color=MUTED, lw=1.8)

# ---------------- client arrows ----------------
arrow(cx + cw, 12.4, px, 10.7, label="HTTP JSON", lx=-0.15, ly=0.45)
arrow(cx + cw, 8.4, px, 10.0, color="#DD344C", label="/admin/*", lx=-0.25, ly=-0.75)

fig.savefig("aws-architecture.png", dpi=140, facecolor="white")
print("ok")
