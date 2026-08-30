import { describe, expect, test } from "bun:test";
import {
  decimalToIntegerString,
  formatBaseUnits,
  normalizeTrc20Amount,
  toBaseUnits,
  trxToSunStr,
} from "./utils";

describe("amount helpers", () => {
  test("converts TRX to sun without losing precision", () => {
    expect(trxToSunStr("1.5")).toBe("1500000");
    expect(trxToSunStr("0.000001")).toBe("1");
  });

  test("normalizes TRC20 amounts with arbitrary decimals", () => {
    expect(normalizeTrc20Amount("1.2345", 6)).toBe("1234500");
    expect(normalizeTrc20Amount("1.23456789", 8)).toBe("123456789");
  });

  test("rejects too many decimal places", () => {
    expect(() => decimalToIntegerString("1.0000001", 6)).toThrow(
      "Too many decimal places"
    );
  });

  test("converts decimal amounts to base units for 18 decimals", () => {
    expect(toBaseUnits("1.5", 18)).toBe("1500000000000000000");
    expect(toBaseUnits("0.000000000000000001", 18)).toBe("1");
  });

  test("formats base units back to decimal strings", () => {
    expect(formatBaseUnits(1500000000000000000n, 18)).toBe("1.5");
    expect(formatBaseUnits(1n, 18)).toBe("0.000000000000000001");
    expect(formatBaseUnits(0n, 18)).toBe("0");
    expect(formatBaseUnits(1500000n, 6)).toBe("1.5");
    expect(formatBaseUnits(42n, 0)).toBe("42");
  });

  test("round-trips base unit conversions", () => {
    expect(formatBaseUnits(BigInt(toBaseUnits("123.456", 18)), 18)).toBe(
      "123.456"
    );
  });
});
