import { describe, expect, it } from "vitest";
import { applyPercentDiscount, percentOfCents } from "../src/domain/money.js";

describe("money", () => {
  it("rounds the discount half up to the cent", () => {
    expect(percentOfCents(1005, 10)).toBe(101); // 100.5 -> 101
    expect(percentOfCents(1004, 10)).toBe(100); // 100.4 -> 100
    expect(percentOfCents(5, 10)).toBe(1); // 0.5 -> 1
  });

  it("avoids floating point drift on amounts that break with floats", () => {
    // 0.1 + 0.2 style problems: 3 x $0.10 with 10% off must be exactly 3 cents
    expect(applyPercentDiscount(30, 10)).toEqual({ discountCents: 3, totalCents: 27 });
  });

  it("never produces a negative total", () => {
    expect(applyPercentDiscount(999, 100)).toEqual({ discountCents: 999, totalCents: 0 });
    expect(applyPercentDiscount(0, 10)).toEqual({ discountCents: 0, totalCents: 0 });
  });

  it("rejects non-integer cents and out-of-range percentages", () => {
    expect(() => percentOfCents(10.5, 10)).toThrow();
    expect(() => percentOfCents(100, 101)).toThrow();
  });
});
