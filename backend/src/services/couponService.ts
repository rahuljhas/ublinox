import { randomBytes } from "node:crypto";
import type { Context } from "../context.js";
import { Errors } from "../domain/errors.js";
import type { Coupon } from "../domain/types.js";

/**
 * Milestone k is reached when placedOrders >= k * n. Each milestone yields at most one coupon,
 * so the number of coupons generated can never exceed floor(placedOrders / n).
 * One call generates the coupon for the earliest unrewarded milestone. This function has no
 * await, so two admin calls cannot both generate for the same milestone.
 */
export function generateCoupon(ctx: Context): Coupon {
  const { store, config } = ctx;
  const reachedMilestones = Math.floor(store.placedOrders / config.couponEveryNOrders);
  const rewardedMilestones = store.coupons.size;
  if (rewardedMilestones >= reachedMilestones) {
    throw Errors.noEligibleMilestone({
      placedOrders: store.placedOrders,
      everyNOrders: config.couponEveryNOrders,
      nextMilestoneAtOrder: (rewardedMilestones + 1) * config.couponEveryNOrders,
    });
  }

  const milestone = rewardedMilestones + 1;
  let code: string;
  do {
    code = `SAVE${config.couponPercentOff}-${randomBytes(3).toString("hex").toUpperCase()}`;
  } while (store.coupons.has(code));

  const coupon: Coupon = {
    code,
    percentOff: config.couponPercentOff,
    milestone,
    unlockedAtOrderCount: milestone * config.couponEveryNOrders,
    status: "AVAILABLE",
    createdAt: new Date().toISOString(),
    redeemedByOrderId: null,
  };
  store.coupons.set(code, coupon);
  return coupon;
}

export function listCoupons(ctx: Context): Coupon[] {
  return [...ctx.store.coupons.values()];
}

export function getCoupon(ctx: Context, code: string): Coupon {
  const coupon = ctx.store.coupons.get(code.trim().toUpperCase());
  if (!coupon) throw Errors.couponNotFound(code);
  return coupon;
}
