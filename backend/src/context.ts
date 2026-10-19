import seed from "./data/products.json" with { type: "json" };
import { KeyedMutex } from "./domain/keyedMutex.js";
import { FakePaymentGateway, type PaymentGateway } from "./domain/payment.js";
import type { Config, Product } from "./domain/types.js";
import { Store } from "./store.js";

export interface Context {
  store: Store;
  config: Config;
  mutex: KeyedMutex;
  payment: PaymentGateway;
}

export function createContext(overrides: Partial<{ seed: Product[]; config: Partial<Config>; payment: PaymentGateway }> = {}): Context {
  const config: Config = {
    couponEveryNOrders: Number(process.env.COUPON_EVERY_N_ORDERS ?? 5),
    couponPercentOff: Number(process.env.COUPON_PERCENT_OFF ?? 10),
    lockWaitMs: Number(process.env.LOCK_WAIT_MS ?? 10_000),
    paymentTimeoutMs: Number(process.env.PAYMENT_TIMEOUT_MS ?? 15_000),
    idempotencyTtlMs: Number(process.env.IDEMPOTENCY_TTL_MS ?? 24 * 60 * 60 * 1000),
    ...overrides.config,
  };
  if (!Number.isInteger(config.couponEveryNOrders) || config.couponEveryNOrders < 1) {
    throw new Error("COUPON_EVERY_N_ORDERS must be a positive integer");
  }
  if (!Number.isInteger(config.couponPercentOff) || config.couponPercentOff < 1 || config.couponPercentOff > 100) {
    throw new Error("COUPON_PERCENT_OFF must be an integer between 1 and 100");
  }
  for (const [name, value] of [["LOCK_WAIT_MS", config.lockWaitMs], ["PAYMENT_TIMEOUT_MS", config.paymentTimeoutMs], ["IDEMPOTENCY_TTL_MS", config.idempotencyTtlMs]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer (milliseconds)`);
  }
  return {
    store: new Store(overrides.seed ?? (seed as Product[])),
    config,
    mutex: new KeyedMutex(config.lockWaitMs),
    payment: overrides.payment ?? new FakePaymentGateway(Number(process.env.PAYMENT_DELAY_MS ?? 150)),
  };
}
