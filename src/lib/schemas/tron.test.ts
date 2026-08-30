import { describe, expect, test } from "bun:test";
import { calculateSchema, calculateSchemaResponse } from "./tron";

const addressA = "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9";
const addressB = "TUdbkixK7zU4ua7YC2oNz6ujsfZxb98GFb";
describe("fee calculation schemas", () => {
  test("rejects the same sender and recipient", () => {
    expect(() =>
      calculateSchema.parse({
        from: addressA,
        to: addressA,
        amount: "1",
      })
    ).toThrow();
  });

  test("rejects contract collisions with sender or recipient", () => {
    expect(() =>
      calculateSchema.parse({
        from: addressA,
        to: addressB,
        amount: "1",
        contract: addressA,
      })
    ).toThrow();
  });

  test("accepts a valid calculation response shape", () => {
    const parsed = calculateSchemaResponse.parse({
      totalFeeTRX: 1.23,
      bandwidth: {
        required: 1,
        available: {
          fromStaking: 1,
          fromFree: 2,
          total: 3,
        },
        coverage: {
          fromStaking: 1,
          fromFree: 1,
          needsToBurn: 0,
          total: 2,
        },
        costTRX: 0,
      },
      energy: {
        required: 1,
        available: 2,
        coverage: {
          fromStaking: 1,
          needsToBurn: 0,
        },
        costTRX: 0,
        baseEnergy: 1,
        energyFactor: 0.0001,
        recipientHasTransactions: true,
      },
      transactionType: "TRC20_TRANSFER",
      timestamp: 1710000000,
    });

    expect(parsed.totalFeeTRX).toBe(1.23);
    expect(parsed.transactionType).toBe("TRC20_TRANSFER");
  });
});
