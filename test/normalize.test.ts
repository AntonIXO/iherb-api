import { describe, expect, test } from "bun:test";

import {
  extractStrengths,
  parsePackageQuantity,
  parseQuantity,
} from "../src/normalize.js";

describe("quantity normalization", () => {
  test("distinguishes thousands separators from decimal commas", () => {
    expect(parseQuantity("1,000 mg")).toMatchObject({
      amount: 1000,
      unit: "mg",
    });
    expect(parseQuantity("1,5 mg")).toMatchObject({
      amount: 1.5,
      unit: "mg",
    });
    expect(parsePackageQuantity("1,000 count")?.amount).toBe(1000);
    expect(extractStrengths("Vitamin C 1,000 mg")).toEqual(["1000mg"]);
  });
});
