/**
 * Money is always an integer number of cents. Floats never touch a stored amount.
 * Rounding happens in exactly one place: the coupon discount, rounded half up to the cent.
 */

export function assertCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer number of cents, got ${value}`);
  }
}

/** percent% of amount, rounded half up. Integer arithmetic only: (a * p + 50) / 100, floored. */
export function percentOfCents(amountCents: number, percent: number): number {
  assertCents(amountCents, "amount");
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error(`percent must be an integer between 0 and 100, got ${percent}`);
  }
  return Math.floor((amountCents * percent + 50) / 100);
}

/** Discount never exceeds the subtotal, so the total can never be negative. */
export function applyPercentDiscount(subtotalCents: number, percent: number) {
  const discountCents = Math.min(subtotalCents, percentOfCents(subtotalCents, percent));
  return { discountCents, totalCents: subtotalCents - discountCents };
}
