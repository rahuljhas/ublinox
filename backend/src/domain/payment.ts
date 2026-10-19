import { randomUUID } from "node:crypto";

export type PaymentResult = { approved: true; reference: string } | { approved: false; reason: string };

export interface PaymentGateway {
  charge(input: { cartId: string; amountCents: number }): Promise<PaymentResult>;
}

/**
 * Stand-in for a real payment provider. It is asynchronous on purpose: the await is the window
 * in which other requests can run, which is exactly what the checkout locks must protect.
 * `declineNext` lets tests force a failure after inventory and coupon have been checked.
 */
export class FakePaymentGateway implements PaymentGateway {
  declineNext = 0;
  /** Every charge attempt, approved or not. Lets tests prove losers of a race are never charged. */
  readonly charges: Array<{ cartId: string; amountCents: number; approved: boolean }> = [];

  constructor(private readonly delayMs = 0) {}

  async charge(input: { cartId: string; amountCents: number }): Promise<PaymentResult> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.declineNext > 0) {
      this.declineNext -= 1;
      this.charges.push({ ...input, approved: false });
      return { approved: false, reason: "card_declined" };
    }
    this.charges.push({ ...input, approved: true });
    return { approved: true, reference: `fake_${randomUUID().slice(0, 8)}` };
  }
}
