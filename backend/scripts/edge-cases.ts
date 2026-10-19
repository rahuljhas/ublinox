/**
 * Black-box edge-case run against a live server. Usage:
 *   npm start                      (in another terminal)
 *   npm run edge-cases             (or BASE_URL=http://host:port npm run edge-cases)
 *
 * Uses only the public HTTP API, so it also works against a deployed instance.
 * Assumes the default config (coupon every 5 orders, 10% off) and seed data.
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const run = Date.now().toString(36);
let keyCounter = 0;
const key = (label: string) => `${label}-${run}-${++keyCounter}`;

type Res = { status: number; body: any; headers: Headers };
async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, raw?: string): Promise<Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

const results: { id: string; name: string; ok: boolean; detail: string }[] = [];
async function check(id: string, name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    results.push({ id, name, ok: true, detail: detail ?? "" });
  } catch (e) {
    results.push({ id, name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function expect(res: Res, status: number, code?: string): string {
  const got = `${res.status}${res.body?.error ? " " + res.body.error.code : ""}`;
  if (res.status !== status || (code && res.body?.error?.code !== code)) throw new Error(`expected ${status}${code ? " " + code : ""}, got ${got}`);
  return got;
}
function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

const newCart = async () => (await http("POST", "/carts")).body.id as string;
async function cartWith(items: Record<string, number>) {
  const id = await newCart();
  for (const [p, q] of Object.entries(items)) expect(await http("PUT", `/carts/${id}/items/${p}`, { quantity: q }), 200);
  return id;
}
const checkout = (cartId: string, k: string, couponCode?: string) =>
  http("POST", `/carts/${cartId}/checkout`, couponCode ? { couponCode } : {}, { "Idempotency-Key": k });
const stock = async (id: string) => ((await http("GET", "/products")).body as any[]).find((p) => p.id === id).inventory as number;

async function main() {
  const health = await http("GET", "/health").catch(() => null);
  if (!health || health.status !== 200) {
    console.error(`No server at ${BASE}. Start it with: cd backend && npm start`);
    process.exit(1);
  }

  // ---------- platform ----------
  await check("P2", "unknown route", async () => expect(await http("GET", "/nope"), 404, "ROUTE_NOT_FOUND"));
  await check("P3", "malformed JSON", async () => expect(await http("PUT", `/carts/${await newCart()}/items/p-mug`, undefined, {}, '{"quantity":'), 400, "INVALID_JSON"));
  await check("P5", "body over 16 KB", async () => expect(await http("PUT", `/carts/${await newCart()}/items/p-mug`, { quantity: 1, pad: "x".repeat(20000) }), 413, "PAYLOAD_TOO_LARGE"));
  await check("P8", "malformed URL encoding", async () => expect(await http("GET", "/carts/%E0%A4%A"), 400, "BAD_REQUEST"));

  // ---------- carts & items ----------
  await check("C3", "get unknown cart", async () => expect(await http("GET", "/carts/ghost"), 404, "CART_NOT_FOUND"));
  for (const [label, body] of [["0", { quantity: 0 }], ["-1", { quantity: -1 }], ["1.5", { quantity: 1.5 }], ['"2"', { quantity: "2" }], ["100", { quantity: 100 }], ["missing", {}], ["extra field", { quantity: 1, x: 1 }]] as const) {
    await check("A5", `quantity ${label}`, async () => expect(await http("PUT", `/carts/${await newCart()}/items/p-mug`, body), 400, "VALIDATION_ERROR"));
  }
  await check("A2", "PUT twice replaces quantity", async () => {
    const id = await cartWith({ "p-mug": 2 });
    const res = await http("PUT", `/carts/${id}/items/p-mug`, { quantity: 5 });
    assert(res.body.items[0].quantity === 5, `quantity is ${res.body.items[0].quantity}`);
    return "quantity 5";
  });
  await check("A4", "quantity above stock", async () => expect(await http("PUT", `/carts/${await newCart()}/items/p-print`, { quantity: 99 }), 409, "INSUFFICIENT_INVENTORY"));
  await check("A7", "unknown product", async () => expect(await http("PUT", `/carts/${await newCart()}/items/ghost`, { quantity: 1 }), 404, "PRODUCT_NOT_FOUND"));
  await check("D2", "remove item not in cart", async () => expect(await http("DELETE", `/carts/${await newCart()}/items/p-mug`), 404, "ITEM_NOT_IN_CART"));

  // ---------- checkout validation ----------
  await check("K2", "missing Idempotency-Key", async () => expect(await http("POST", `/carts/${await cartWith({ "p-mug": 1 })}/checkout`, {}), 400, "IDEMPOTENCY_KEY_REQUIRED"));
  await check("K2", "Idempotency-Key too short", async () => expect(await checkout(await cartWith({ "p-mug": 1 }), "short"), 400, "IDEMPOTENCY_KEY_REQUIRED"));
  await check("K23", "Idempotency-Key with a comma", async () => expect(await checkout(await cartWith({ "p-mug": 1 }), "key-one-1, key-two-2"), 400, "IDEMPOTENCY_KEY_REQUIRED"));
  await check("K3", "empty cart", async () => expect(await checkout(await newCart(), key("empty")), 422, "CART_EMPTY"));
  await check("K4", "unknown cart", async () => expect(await checkout("ghost", key("ghost")), 404, "CART_NOT_FOUND"));
  await check("K7", "unknown coupon", async () => expect(await checkout(await cartWith({ "p-mug": 1 }), key("nocoupon"), "NOPE-000"), 404, "COUPON_NOT_FOUND"));
  await check("K22", "couponCode not a string", async () =>
    expect(await http("POST", `/carts/${await cartWith({ "p-mug": 1 })}/checkout`, { couponCode: 5 }, { "Idempotency-Key": key("type") }), 400, "VALIDATION_ERROR"));

  // ---------- checkout behaviour ----------
  await check("K1/K12", "checkout, then retry with the same key", async () => {
    const id = await cartWith({ "p-pens": 2 });
    const before = await stock("p-pens");
    const k = key("retry");
    const first = await checkout(id, k);
    const again = await checkout(id, k);
    expect(first, 201);
    assert(again.body.id === first.body.id, "retry returned a different order");
    assert(again.headers.get("idempotent-replayed") === "true", "replay header missing");
    assert((await stock("p-pens")) === before - 2, "stock charged twice");
    return "same order, stock -2 once";
  });
  await check("K6", "second checkout of same cart, new key", async () => {
    const id = await cartWith({ "p-pens": 1 });
    expect(await checkout(id, key("once")), 201);
    return expect(await checkout(id, key("twice")), 409, "CART_ALREADY_CHECKED_OUT");
  });
  await check("K14", "same key reused for another cart", async () => {
    const k = key("reuse");
    expect(await checkout(await cartWith({ "p-pens": 1 }), k), 201);
    return expect(await checkout(await cartWith({ "p-pens": 1 }), k), 422, "IDEMPOTENCY_KEY_REUSED");
  });
  await check("K13", "same key sent twice at once", async () => {
    const id = await cartWith({ "p-pens": 1 });
    const k = key("parallel");
    const [a, b] = await Promise.all([checkout(id, k), checkout(id, k)]);
    const statuses = [a.status, b.status].sort().join(",");
    assert(statuses === "201,409", `statuses ${statuses}`);
    return "201 + 409 REQUEST_IN_PROGRESS";
  });
  await check("K17", "same cart, two keys at once", async () => {
    const id = await cartWith({ "p-pens": 1 });
    const [a, b] = await Promise.all([checkout(id, key("cartA")), checkout(id, key("cartB"))]);
    const statuses = [a.status, b.status].sort().join(",");
    assert(statuses === "201,409", `statuses ${statuses}`);
    return "one order";
  });
  await check("K16", "6 carts race for the limited print", async () => {
    const left = await stock("p-print");
    const carts = await Promise.all(Array.from({ length: 6 }, () => newCart()));
    await Promise.all(carts.map((c) => http("PUT", `/carts/${c}/items/p-print`, { quantity: 1 })));
    const res = await Promise.all(carts.map((c) => checkout(c, key("print"))));
    const won = res.filter((r) => r.status === 201).length;
    assert(won === Math.min(left, 6), `${won} succeeded with ${left} in stock`);
    assert((await stock("p-print")) === left - won, "stock mismatch");
    return `${won} won, stock ${left} → ${left - won}`;
  });
  await check("K5", "stock dropped after adding to cart", async () => {
    const id = await cartWith({ "p-lamp": 2 });
    const original = await stock("p-lamp");
    await http("PATCH", "/admin/products/p-lamp", { inventory: 1 });
    const res = await checkout(id, key("drop"));
    await http("PATCH", "/admin/products/p-lamp", { inventory: original });
    return expect(res, 409, "INSUFFICIENT_INVENTORY");
  });

  // ---------- coupons ----------
  await check("M1-M5", "coupon milestones and concurrent generation", async () => {
    // Reach the next milestone, then fire 5 generate calls at once.
    const report = (await http("GET", "/admin/report")).body;
    const n = report.couponRule.everyNOrders;
    const pending = report.couponRule.eligibleUnrewardedMilestones;
    for (let i = 0; i < pending; i++) await http("POST", "/admin/coupons"); // clear any backlog
    expect(await http("POST", "/admin/coupons"), 409, "NO_ELIGIBLE_MILESTONE");
    const toNext = n - (report.ordersPlaced % n);
    for (let i = 0; i < toNext; i++) expect(await checkout(await cartWith({ "p-pens": 1 }), key("milestone")), 201);
    const gen = await Promise.all(Array.from({ length: 5 }, () => http("POST", "/admin/coupons")));
    const created = gen.filter((r) => r.status === 201);
    assert(created.length === 1, `${created.length} coupons created`);
    return `1 coupon (${created[0].body.code})`;
  });
  await check("K18", "same coupon, two carts at once", async () => {
    const coupon = ((await http("GET", "/admin/coupons")).body as any[]).find((c) => c.status === "AVAILABLE");
    assert(coupon, "no available coupon");
    const [a, b] = await Promise.all([
      checkout(await cartWith({ "p-mug": 1 }), key("couponA"), coupon.code),
      checkout(await cartWith({ "p-mug": 1 }), key("couponB"), coupon.code),
    ]);
    const winner = [a, b].find((r) => r.status === 201);
    const loser = [a, b].find((r) => r.status === 409);
    assert(winner && loser?.body.error.code === "COUPON_ALREADY_REDEEMED", `statuses ${a.status}, ${b.status}`);
    assert(winner!.body.discountCents === 145, `discount ${winner!.body.discountCents}`);
    return "one discounted order, $1.45 off $14.50";
  });
  await check("Q2", "coupon shows REDEEMED after use", async () => {
    const coupon = ((await http("GET", "/admin/coupons")).body as any[]).find((c) => c.status === "REDEEMED");
    const res = await http("GET", `/coupons/${coupon.code.toLowerCase()}`);
    assert(res.body.status === "REDEEMED", res.body.status);
    return "REDEEMED (lower-case lookup)";
  });

  // ---------- orders, report, admin ----------
  await check("O2", "unknown order", async () => expect(await http("GET", "/orders/ghost"), 404, "ORDER_NOT_FOUND"));
  await check("U2", "admin patch with empty body", async () => expect(await http("PATCH", "/admin/products/p-mug", {}), 400, "VALIDATION_ERROR"));
  await check("U4", "admin patch unknown product", async () => expect(await http("PATCH", "/admin/products/ghost", { inventory: 1 }), 404, "PRODUCT_NOT_FOUND"));
  await check("R2/R4", "report reconciles and is read-only", async () => {
    const a = (await http("GET", "/admin/report")).body;
    const b = (await http("GET", "/admin/report")).body;
    assert(JSON.stringify(a) === JSON.stringify(b), "two reads differ");
    assert(a.netRevenueCents === a.grossRevenueCents - a.totalDiscountCents, "net != gross - discount");
    assert(a.coupons.generated === a.coupons.available + a.coupons.redeemed, "coupon counts do not add up");
    return `${a.ordersPlaced} orders, net $${(a.netRevenueCents / 100).toFixed(2)}`;
  });

  // ---------- print ----------
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(7)} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} edge cases passed against ${BASE}`);
  process.exit(failed ? 1 : 0);
}

void main();
