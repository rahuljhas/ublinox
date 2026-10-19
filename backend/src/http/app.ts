import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Context } from "../context.js";
import { AppError, Errors } from "../domain/errors.js";
import { createCart, removeItem, setItemQuantity, viewCart } from "../services/cartService.js";
import { checkout, getOrder } from "../services/checkoutService.js";
import { generateCoupon, getCoupon, listCoupons } from "../services/couponService.js";
import { listProducts, updateProduct } from "../services/productService.js";
import { buildReport } from "../services/reportService.js";

const quantityBody = z.object({ quantity: z.number().int().min(1).max(99) }).strict();
const checkoutBody = z.object({ couponCode: z.string().trim().min(1).max(40).optional() }).strict();
// Letters, digits and . _ : - only. Rejects two headers joined by a comma into one ambiguous key.
const idempotencyKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/);
const productPatch = z
  .object({
    priceCents: z.number().int().min(0).max(100_000_000).optional(),
    inventory: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .refine((patch) => patch.priceCents !== undefined || patch.inventory !== undefined, "Send priceCents and/or inventory");

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw Errors.validation({ issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  return result.data;
}

export function createApp(ctx: Context) {
  const app = express();
  app.use(express.json({ limit: "16kb" }));

  // Allow a browser frontend on another origin during development.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.header("Access-Control-Expose-Headers", "Idempotent-Replayed");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  app.get("/health", (_req, res) => void res.json({ status: "ok" }));

  // ---------- catalog ----------
  app.get("/products", (_req, res) => void res.json(listProducts(ctx)));

  // ---------- carts ----------
  app.post("/carts", (_req, res) => void res.status(201).json(createCart(ctx)));
  app.get("/carts/:cartId", (req, res) => void res.json(viewCart(ctx, req.params.cartId)));
  app.put("/carts/:cartId/items/:productId", async (req, res) => {
    const { quantity } = parse(quantityBody, req.body);
    res.json(await setItemQuantity(ctx, req.params.cartId, req.params.productId, quantity));
  });
  app.delete("/carts/:cartId/items/:productId", async (req, res) => {
    res.json(await removeItem(ctx, req.params.cartId, req.params.productId));
  });

  // ---------- checkout & orders ----------
  app.post("/carts/:cartId/checkout", async (req, res) => {
    const key = idempotencyKey.safeParse(req.header("Idempotency-Key"));
    if (!key.success) throw Errors.idempotencyKeyRequired();
    const body = parse(checkoutBody, req.body);
    const result = await checkout(ctx, { cartId: req.params.cartId, idempotencyKey: key.data, couponCode: body.couponCode });
    res.header("Idempotent-Replayed", String(result.replayed)).status(result.status).json(result.body);
  });
  app.get("/orders/:orderId", (req, res) => void res.json(getOrder(ctx, req.params.orderId)));
  app.get("/coupons/:code", (req, res) => {
    const { code, percentOff, status } = getCoupon(ctx, req.params.code);
    res.json({ code, percentOff, status });
  });

  // ---------- admin (no auth; treated as administrative by route prefix) ----------
  app.post("/admin/coupons", (_req, res) => void res.status(201).json(generateCoupon(ctx)));
  app.get("/admin/coupons", (_req, res) => void res.json(listCoupons(ctx)));
  app.get("/admin/report", (_req, res) => void res.json(buildReport(ctx)));
  app.patch("/admin/products/:productId", async (req, res) => {
    res.json(await updateProduct(ctx, req.params.productId, parse(productPatch, req.body)));
  });

  app.use(() => {
    throw Errors.notFound();
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      return void res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details ?? {} } });
    }
    if (error instanceof SyntaxError && "body" in error) {
      return void res.status(400).json({ error: { code: "INVALID_JSON", message: "The request body is not valid JSON.", details: {} } });
    }
    // Client errors raised by Express itself (body too large, bad URL encoding, ...) stay 4xx.
    const status = typeof error === "object" && error !== null ? Number((error as { status?: unknown }).status) : NaN;
    if (status >= 400 && status < 500) {
      const [code, message] =
        status === 413
          ? ["PAYLOAD_TOO_LARGE", "The request body is larger than 16 KB."]
          : status === 415
            ? ["UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json."]
            : ["BAD_REQUEST", "The request could not be understood."];
      return void res.status(status).json({ error: { code, message, details: {} } });
    }
    console.error(error);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side.", details: {} } });
  });

  return app;
}
