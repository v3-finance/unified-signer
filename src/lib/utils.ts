import { InputError } from "./errors";

export const roundToDecimals = (value: number, decimals: number): number => {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
};

export const cleanString = (str: string): string => {
  if (!str) {
    return "";
  }

  return str
    .replace(/\x00/g, "")
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

export function json(
  obj: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function decimalToIntegerString(value: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new InputError("Invalid decimal amount");
  }

  const [integerPart, fractionalPart = ""] = value.split(".");

  if (fractionalPart.length > decimals) {
    throw new InputError(`Too many decimal places (max ${decimals})`);
  }

  const normalized = `${integerPart}${fractionalPart.padEnd(decimals, "0")}`
    .replace(/^0+/, "");

  return normalized === "" ? "0" : normalized;
}

export function trxToSunStr(amount: string | number): string {
  const value = typeof amount === "number" ? amount.toString() : amount;
  return decimalToIntegerString(value, 6);
}

export function normalizeTrc20Amount(
  amount: string | number,
  decimals?: number
): string {
  const value = typeof amount === "number" ? amount.toString() : amount;

  if (decimals === undefined) {
    if (!/^\d+$/.test(value)) {
      throw new InputError(
        "TRC20 amount must be integer base units when decimals are omitted"
      );
    }

    return value;
  }

  return decimalToIntegerString(value, decimals);
}

export function toBaseUnits(amount: string | number, decimals: number): string {
  const value = typeof amount === "number" ? amount.toString() : amount;
  return decimalToIntegerString(value, decimals);
}

export function formatBaseUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const digits = absolute.toString().padStart(decimals + 1, "0");
  const integerPart = digits.slice(0, digits.length - decimals);
  const fractionalPart = decimals
    ? digits.slice(digits.length - decimals).replace(/0+$/, "")
    : "";

  return `${negative ? "-" : ""}${integerPart}${
    fractionalPart ? `.${fractionalPart}` : ""
  }`;
}

/** Canonical decimal form for fingerprints: "032000.50" -> "32000.5". */
export function normalizeDecimalString(value: string): string {
  const [integerPart, fractionalPart = ""] = value.trim().split(".");
  const integer = integerPart.replace(/^0+(?=\d)/, "");
  const fraction = fractionalPart.replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}
