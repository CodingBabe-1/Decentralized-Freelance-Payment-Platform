import { describe, it, expect } from "vitest";
import {
  formatAmount,
  formatBaseUnitsForAsset,
  fromBaseUnits,
  getAsset,
  sumAmounts,
  toBaseUnits,
  UnknownAssetError,
} from "../lib/assets";

describe("asset registry", () => {
  it("converts amounts using each asset's decimals", () => {
    expect(toBaseUnits("1.5", getAsset("USDC").decimals)).toBe(15_000_000n);
    expect(toBaseUnits("0.1", getAsset("XLM").decimals)).toBe(1_000_000n);
    // Trailing precision is padded to the asset's scale.
    expect(toBaseUnits(2, getAsset("USDC").decimals)).toBe(20_000_000n);
  });

  it("looks up assets case-insensitively", () => {
    expect(getAsset("usdc").symbol).toBe("USDC");
    expect(getAsset(" Xlm ").symbol).toBe("XLM");
  });

  it("rejects an unknown asset", () => {
    expect(() => getAsset("DOGE")).toThrow(UnknownAssetError);
  });
});

describe("fromBaseUnits", () => {
  const decimals = getAsset("USDC").decimals;

  it("renders base units as a decimal string", () => {
    expect(fromBaseUnits(10_000_000n, decimals)).toBe("1");
    expect(fromBaseUnits(15_000_000n, decimals)).toBe("1.5");
    expect(fromBaseUnits(25_000_000n, decimals)).toBe("2.5");
    // Below one whole unit, and a single base unit.
    expect(fromBaseUnits(1n, decimals)).toBe("0.0000001");
    expect(fromBaseUnits(0n, decimals)).toBe("0");
  });

  it("round-trips through toBaseUnits", () => {
    for (const amount of ["1", "2.5", "0.1", "1234.5678901", "0.0000001"]) {
      expect(fromBaseUnits(toBaseUnits(amount, decimals), decimals)).toBe(amount);
    }
  });

  it("handles an asset with no fractional part", () => {
    expect(fromBaseUnits(1_000n, 0)).toBe("1000");
  });
});

describe("exact money arithmetic", () => {
  const decimals = getAsset("USDC").decimals;

  it("sums decimal amounts in base units instead of floats", () => {
    // The bug this guards: IEEE-754 addition is not exact.
    expect(0.1 + 0.1 + 0.1).not.toBe(0.3);
    expect([0.1, 0.1, 0.1].reduce((sum, n) => sum + n, 0)).toBe(0.30000000000000004);

    // Three 0.1 milestones sum to exactly 0.3, not 0.30000000000000004.
    expect(sumAmounts([0.1, 0.1, 0.1], decimals)).toBe(3_000_000n);
    expect(formatAmount(sumAmounts([0.1, 0.1, 0.1], decimals), decimals)).toBe("0.3");
  });

  it("handles the 0.1 + 0.2 case and mixed number/string inputs", () => {
    expect(formatAmount(sumAmounts([0.1, 0.2], decimals), decimals)).toBe("0.3");
    // A decimal string is exact on arrival; a number is already a binary float.
    expect(formatAmount(sumAmounts(["0.1", "0.2"], decimals), decimals)).toBe("0.3");
    expect(formatAmount(sumAmounts([1, "0.5"], decimals), decimals)).toBe("1.5");
  });

  it("formats base units without trailing zeros", () => {
    expect(formatAmount(3_000_000n, 7)).toBe("0.3");
    expect(formatAmount(20_000_000n, 7)).toBe("2");
    expect(formatAmount(0n, 7)).toBe("0");
    expect(formatAmount(123_456_789n, 7)).toBe("12.3456789");
  });
});

describe("formatBaseUnitsForAsset", () => {
  it("renders base units in whole units for the event's asset", () => {
    expect(formatBaseUnitsForAsset("20000000", "USDC")).toBe("2");
    expect(formatBaseUnitsForAsset(3_000_000n, "XLM")).toBe("0.3");
    expect(formatBaseUnitsForAsset("123456789", "USDC")).toBe("12.3456789");
  });

  it("returns the raw value when the asset is unknown or missing", () => {
    // Falling back to 7 decimals for an unregistered symbol would be a guess; a
    // raw figure is honest and still inspectable.
    expect(formatBaseUnitsForAsset("20000000", "DOGE")).toBe("20000000");
    expect(formatBaseUnitsForAsset("20000000", null)).toBe("20000000");
  });
});
