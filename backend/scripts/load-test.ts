/**
 * Concurrent-shoppers load test. Black-box: uses only the public HTTP API, so it also works against a
 * deployed instance. Usage:
 *   npm start                            (other terminal)
 *   USERS=200 npm run load               (BASE_URL=https://host to target another server)
 *
 * It CHANGES DATA on the target (orders, stock, coupons, the hot product's stock is reset to 3), so run it on a
 * test instance. The live Render service is restarted afterwards to reset its in-memory data.
 *
 * Phases: 1 hot product race · 2 mixed shoppers with admin price edits · 3 double-click · 4 coupon race.
 * Afterwards it checks the invariants against what the clients saw and what the server reports.
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const USERS = Number(process.env.USERS ?? 100);
const HOT_SHOPPERS = Number(process.env.HOT_SHOPPERS ?? 30);
const DOUBLE_CLICKERS = Number(process.env.DOUBLE_CLICKERS ?? 20);
const COUPON_RACERS = Number(process.env.COUPON_RACERS ?? 10);
const run = Date.now().toString(36);
let seq = 0;
const key = (label: string) => `${label}-${run}-${++seq}`;

let seed = Number(process.env.SEED ?? 12345);
const random = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];

type Res = { status: number; body: any; headers: Headers };
const latencies = new Map<string, number[]>();
const outcomes = new Map<string, number>();

async function http(label: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const started = performance.now();
  let res: Res;
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    res = { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  } catch {
    res = { status: 0, body: null, headers: new Headers() };
  }
  const ms = performance.now() - started;
  (latencies.get(label) ?? latencies.set(label, []).get(label)!).push(ms);
  const outcome = `${label} → ${res.status}${res.body?.error ? " " + res.body.error.code : ""}`;
  outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  return res;
}

const checkoutReq = (cartId: string, k: string, extra: Record<string, unknown> = {}) =>
  http("checkout", "POST", `/carts/${cartId}/checkout`, extra, { "Idempotency-Key": k });

// What the clients saw: unique successful orders (a replayed response has the same id).
const orders = new Map<string, any>();
// Stock we added through the admin API during the run (so the conservation check can account for it).
const restocked = new Map<string, number>();
const noteOrder = (res: Res) => res.status === 201 && orders.set(res.body.id, res.body);

const failures: string[] = [];
const expectCheck = (ok: boolean, name: string, detail: string) => {
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
};
const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

async function snapshot() {
  const [products, report, history] = await Promise.all([
    http("read", "GET", "/products"),
    http("read", "GET", "/admin/report"),
    http("read", "GET", "/admin/orders?limit=1"),
  ]);
  const sold = new Map<string, number>(report.body.productsSold.map((p: any) => [p.productId, p.quantity]));
  return { stock: new Map<string, number>(products.body.map((p: any) => [p.id, p.inventory])), products: products.body as any[], report: report.body, ordersTotal: history.body.total as number, sold };
}

async function cartWith(items: Array<[string, number]>) {
  const cart = (await http("create cart", "POST", "/carts")).body;
  let last: Res | null = null;
  for (const [productId, quantity] of items) {
    const res = await http("add item", "PUT", `/carts/${cart.id}/items/${productId}`, { quantity });
    if (res.status === 200) last = res;
  }
  return { id: cart.id as string, subtotalCents: last?.body.subtotalCents as number | undefined };
}

async function main() {
  if ((await http("read", "GET", "/health")).status !== 200) {
    console.error(`No server at ${BASE}. Start it with: cd backend && npm start`);
    process.exit(1);
  }
  const catalog = (await http("read", "GET", "/products")).body as any[];
  const hot = catalog.reduce((a, b) => (b.inventory < a.inventory ? b : a));
  const others = catalog.filter((p) => p.id !== hot.id);
  await http("admin", "PATCH", `/admin/products/${hot.id}`, { inventory: 3 });
  const before = await snapshot();
  const started = performance.now();
  console.log(`Target ${BASE} · ${USERS} mixed shoppers · ${HOT_SHOPPERS} on "${hot.name}" (stock 3) · ${DOUBLE_CLICKERS} double-clickers · ${COUPON_RACERS} coupon racers\n`);

  // ---- Phase 1: hot product. Everyone fills a cart first, then all check out at the same moment.
  const hotCarts = await Promise.all(Array.from({ length: HOT_SHOPPERS }, () => cartWith([[hot.id, 1]])));
  const hotResults = await Promise.all(hotCarts.map((c) => checkoutReq(c.id, key("hot"), c.subtotalCents ? { expectedSubtotalCents: c.subtotalCents } : {})));
  hotResults.forEach(noteOrder);
  const hotWins = hotResults.filter((r) => r.status === 201).length;
  expectCheck(hotWins === Math.min(3, HOT_SHOPPERS), "1 hot product: exactly the stock sells", `${hotWins} orders for 3 units, ${HOT_SHOPPERS - hotWins} refused`);

  // ---- Phase 2: mixed shoppers, with admin price changes landing mid-run.
  const priceTarget = pick(others);
  const priceEdits = [1, 2].map((i) => new Promise((r) => setTimeout(r, 40 * i)).then(() => http("admin", "PATCH", `/admin/products/${priceTarget.id}`, { priceCents: priceTarget.priceCents + 25 * i })));
  const shoppers = Array.from({ length: USERS }, async () => {
    const wanted = [...catalog].sort(() => random() - 0.5).slice(0, 1 + Math.floor(random() * 3));
    const cart = await cartWith(wanted.map((p) => [p.id, 1 + Math.floor(random() * 2)] as [string, number]));
    if (cart.subtotalCents === undefined) return; // every add was refused (sold out)
    const guard = random() < 0.5 ? { expectedSubtotalCents: cart.subtotalCents } : {};
    noteOrder(await checkoutReq(cart.id, key("mixed"), guard));
  });
  await Promise.all([...shoppers, ...priceEdits]);
  await http("admin", "PATCH", `/admin/products/${priceTarget.id}`, { priceCents: priceTarget.priceCents }); // restore

  // ---- Phase 3: double-click. The same checkout, same key, twice at once.
  // Use whichever product has the most stock left right now; top it up only if it cannot cover phases 3 and 4.
  const nowStock = (await snapshot()).stock;
  const cheap = others.reduce((a, b) => (nowStock.get(b.id)! > nowStock.get(a.id)! ? b : a));
  const needed = DOUBLE_CLICKERS + COUPON_RACERS + 5;
  if (nowStock.get(cheap.id)! < needed) {
    restocked.set(cheap.id, needed - nowStock.get(cheap.id)!);
    await http("admin", "PATCH", `/admin/products/${cheap.id}`, { inventory: needed });
  }
  const stockBeforeDouble = (await snapshot()).stock;
  let doubleOk = 0;
  await Promise.all(
    Array.from({ length: DOUBLE_CLICKERS }, async () => {
      const cart = await cartWith([[cheap.id, 1]]);
      const k = key("double");
      const pair = await Promise.all([checkoutReq(cart.id, k), checkoutReq(cart.id, k)]);
      pair.forEach(noteOrder);
      const wins = pair.filter((r) => r.status === 201);
      const ids = new Set(wins.map((r) => r.body.id));
      if (wins.length >= 1 && ids.size === 1 && pair.every((r) => r.status === 201 || r.body?.error?.code === "REQUEST_IN_PROGRESS")) doubleOk++;
    }),
  );
  expectCheck(doubleOk === DOUBLE_CLICKERS, "3 double-click: one order per shopper", `${doubleOk}/${DOUBLE_CLICKERS} shoppers got exactly one order`);
  const afterDouble = (await snapshot()).stock;
  expectCheck(
    stockBeforeDouble.get(cheap.id)! - afterDouble.get(cheap.id)! === DOUBLE_CLICKERS,
    "3 double-click: stock taken once each",
    `${cheap.name}: -${stockBeforeDouble.get(cheap.id)! - afterDouble.get(cheap.id)!} for ${DOUBLE_CLICKERS} shoppers`,
  );

  // ---- Phase 4: one coupon, many carts at the same moment.
  const generated = await http("admin", "POST", "/admin/coupons");
  if (generated.status === 201) {
    const racers = await Promise.all(Array.from({ length: COUPON_RACERS }, () => cartWith([[cheap.id, 1]])));
    const results = await Promise.all(racers.map((c) => checkoutReq(c.id, key("coupon"), { couponCode: generated.body.code })));
    results.forEach(noteOrder);
    const winners = results.filter((r) => r.status === 201);
    expectCheck(winners.length === 1 && winners[0].body.discountCents > 0, "4 coupon race: used exactly once", `${winners.length} discounted order(s) of ${COUPON_RACERS}`);
    expectCheck(
      results.filter((r) => r.status !== 201).every((r) => r.body?.error?.code === "COUPON_ALREADY_REDEEMED"),
      "4 coupon race: losers told it was redeemed",
      "every refusal is COUPON_ALREADY_REDEEMED",
    );
  } else {
    expectCheck(false, "4 coupon race", `could not generate a coupon (${generated.status} ${generated.body?.error?.code})`);
  }

  const seconds = (performance.now() - started) / 1000;
  const after = await snapshot();
  console.log();

  // ---- Verification against what the clients saw.
  const unique = [...orders.values()];
  const soldByClients = new Map<string, number>();
  for (const o of unique) for (const l of o.lines) soldByClients.set(l.productId, (soldByClients.get(l.productId) ?? 0) + l.quantity);
  const stockOk = catalog.every((p) => {
    const delta = before.stock.get(p.id)! + (restocked.get(p.id) ?? 0) - after.stock.get(p.id)!;
    return delta === (soldByClients.get(p.id) ?? 0) && after.stock.get(p.id)! >= 0;
  });
  expectCheck(stockOk, "stock: sold + remaining = starting, never < 0", `${catalog.map((p) => `${p.id.replace("p-", "")} -${soldByClients.get(p.id) ?? 0}`).join(", ")}`);
  expectCheck(after.report.ordersPlaced - before.report.ordersPlaced === unique.length, "orders: server count = orders clients got", `${after.report.ordersPlaced - before.report.ordersPlaced} on server, ${unique.length} seen`);
  expectCheck(after.ordersTotal - before.ordersTotal === unique.length, "history: /admin/orders total matches", `+${after.ordersTotal - before.ordersTotal}`);
  const sumTotals = unique.reduce((s, o) => s + o.totalCents, 0);
  const sumDiscounts = unique.reduce((s, o) => s + o.discountCents, 0);
  expectCheck(after.report.netRevenueCents - before.report.netRevenueCents === sumTotals, "revenue: net = sum of amounts charged", `${money(sumTotals)} charged`);
  expectCheck(after.report.totalDiscountCents - before.report.totalDiscountCents === sumDiscounts, "revenue: discounts add up", `${money(sumDiscounts)} discounted`);
  expectCheck(unique.every((o) => o.totalCents >= 0 && o.totalCents === o.subtotalCents - o.discountCents), "money: totals never negative, add up", `${unique.length} orders checked`);
  expectCheck(
    after.report.coupons.generated === after.report.coupons.available + after.report.coupons.redeemed,
    "coupons: generated = available + redeemed",
    JSON.stringify(after.report.coupons),
  );
  const allowed = /^(create cart|add item|read|admin) → (200|201)$|^checkout → (201|409 (INSUFFICIENT_INVENTORY|PRICE_CHANGED|REQUEST_IN_PROGRESS|COUPON_ALREADY_REDEEMED)|409 CART_ALREADY_CHECKED_OUT)$|^add item → 409 INSUFFICIENT_INVENTORY$|^admin → 409 NO_ELIGIBLE_MILESTONE$|^(checkout|add item|admin) → 503 SERVER_BUSY$/;
  const surprises = [...outcomes.keys()].filter((o) => !allowed.test(o));
  expectCheck(surprises.length === 0, "errors: only expected codes, no 5xx", surprises.length ? surprises.join("; ") : "none unexpected");

  // ---- Summary tables.
  console.log("\nOutcomes");
  for (const [outcome, count] of [...outcomes].sort()) console.log(`  ${String(count).padStart(5)}  ${outcome}`);
  console.log("\nLatency (ms)            count     p50     p95     max");
  for (const label of ["checkout", "add item", "create cart"]) {
    const v = latencies.get(label) ?? [];
    console.log(`  ${label.padEnd(18)} ${String(v.length).padStart(7)} ${pct(v, 50).toFixed(0).padStart(7)} ${pct(v, 95).toFixed(0).padStart(7)} ${Math.max(0, ...v).toFixed(0).padStart(7)}`);
  }
  const requests = [...latencies.values()].reduce((s, v) => s + v.length, 0);
  const shed = [...outcomes].filter(([o]) => o.endsWith("503 SERVER_BUSY")).reduce((n, [, c]) => n + c, 0);
  if (shed) console.log(`\n${shed} request(s) were shed with 503 SERVER_BUSY (waited longer than LOCK_WAIT_MS); clients should retry with the same key.`);
  console.log(`\n${requests} requests in ${seconds.toFixed(1)} s (${(requests / seconds).toFixed(0)}/s) · ${unique.length} orders placed (${(unique.length / seconds).toFixed(1)}/s)`);
  console.log(failures.length ? `\n${failures.length} CHECK(S) FAILED` : "\nAll checks passed");
  process.exit(failures.length ? 1 : 0);
}

void main();
