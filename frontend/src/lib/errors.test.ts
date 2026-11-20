import { describe, expect, it } from "vitest";
import {
  UNKNOWN_ERROR_MESSAGE,
  ContractCallError,
  ContractReadError,
  asReadError,
  classifyReadFailure,
  describeReadFailure,
  friendlyError,
  parseContractErrorCode,
  type ContractErrorContract,
} from "./errors";

describe("parseContractErrorCode", () => {
  it("extracts the code from a contract error", () => {
    expect(parseContractErrorCode("HostError: Error(Contract, #6)")).toBe(6);
    expect(parseContractErrorCode("Error(Contract, #13)")).toBe(13);
  });

  it("returns null when there is no contract error code", () => {
    expect(parseContractErrorCode("Transaction rejected")).toBeNull();
  });
});

describe("friendlyError", () => {
  const soroban = (code: number) => new Error("HostError: Error(Contract, #" + code + ")");

  const cases: Array<[ContractErrorContract, number, string]> = [
    ["escrow", 1, "could not be found"],
    ["escrow", 2, "current state"],
    ["escrow", 3, "not authorized"],
    ["escrow", 4, "already been released"],
    ["escrow", 5, "index is out of range"],
    ["escrow", 6, "expiry"],
    ["escrow", 7, "greater than zero"],
    ["escrow", 8, "milestone list"],
    ["escrow", 9, "expiry time"],
    ["escrow", 10, "different addresses"],
    ["escrow", 11, "already initialized"],
    ["escrow", 12, "isn't initialized"],
    ["escrow", 13, "payout shares"],
    ["escrow", 14, "too large"],
    ["escrow", 15, "what's left"],
    ["escrow", 16, "timeout hasn't"],
    ["escrow", 17, "20 milestones"],
    ["escrow", 18, "greater than zero"],
    ["escrow", 19, "paused"],
    ["escrow", 20, "no pending"],
    ["escrow", 21, "timelocked"],
    ["escrow", 22, "address is invalid"],
    ["dispute", 1, "could not be found"],
    ["dispute", 2, "already initialized"],
    ["dispute", 3, "isn't initialized"],
    ["dispute", 4, "current state"],
    ["dispute", 5, "already been raised"],
    ["dispute", 6, "escrow could not be found"],
    ["dispute", 7, "before raising"],
    ["dispute", 8, "client or freelancer"],
    ["dispute", 9, "proposed payout"],
    ["dispute", 10, "too large"],
    ["dispute", 11, "panel is invalid"],
    ["dispute", 12, "threshold is invalid"],
    ["dispute", 13, "Not enough arbitrators"],
    ["dispute", 14, "paused"],
    ["reputation", 1, "could not be found"],
    ["reputation", 2, "already initialized"],
    ["reputation", 3, "isn't initialized"],
    ["reputation", 4, "between 1 and 5"],
    ["reputation", 5, "already rated"],
    ["reputation", 6, "escrow could not be found"],
    ["reputation", 7, "must be completed"],
    ["reputation", 8, "Only participants"],
    ["reputation", 9, "other participant"],
    ["reputation", 10, "too large"],
  ];

  it.each(cases)("%s contract error #%i has a short human message", (contract, code, fragment) => {
    const message = friendlyError(soroban(code), contract);
    expect(message).toContain(fragment);
    expect(message).not.toContain("HostError");
  });

  it("does not mix overlapping contract codes", () => {
    expect(friendlyError(soroban(4), "escrow")).toContain("milestone");
    expect(friendlyError(soroban(4), "dispute")).toContain("dispute's current state");
    expect(friendlyError(soroban(4), "reputation")).toContain("score");
    expect(friendlyError(soroban(7), "escrow")).toContain("amount greater than zero");
    expect(friendlyError(soroban(7), "reputation")).toContain("completed");
  });

  it("safely handles unknown codes and arbitrary SDK errors", () => {
    const unknowns: unknown[] = [
      soroban(999),
      new Error("HostError: Error(Contract, #999)\n  at private/path"),
      new Error("RPC internal stack\n  at secret/path"),
      "Unrecognized private SDK data",
      undefined,
      { toString: () => { throw new Error("secret"); } },
    ];
    for (const input of unknowns) {
      expect(friendlyError(input)).toBe(UNKNOWN_ERROR_MESSAGE);
    }
    expect(friendlyError(soroban(23), "escrow")).toBe(UNKNOWN_ERROR_MESSAGE);
    expect(friendlyError(soroban(15), "dispute")).toBe(UNKNOWN_ERROR_MESSAGE);
    expect(friendlyError(soroban(11), "reputation")).toBe(UNKNOWN_ERROR_MESSAGE);
    expect(friendlyError(new Error("HostError: Error(Contract, #17)\n  at secret/path"), "escrow"))
      .toBe("You can create at most 20 milestones.");
  });

  it("keeps only safe, recognized wallet and network copy", () => {
    expect(friendlyError(new Error("Wallet not connected"))).toContain("Connect your wallet");
    expect(friendlyError(new Error("Failed to fetch"))).toContain("Check your connection");
    expect(friendlyError(new Error("User rejected"))).toContain("cancelled");
    expect(friendlyError(new Error("Transaction rejected: internal details"))).toBe(UNKNOWN_ERROR_MESSAGE);
  });

  it("retains the contract scope on multi-contract failures", () => {
    const wrapped = new ContractCallError(soroban(8), "dispute");
    expect(wrapped.contract).toBe("dispute");
    expect(parseContractErrorCode(wrapped.message)).toBe(8);
    expect(friendlyError(wrapped, wrapped.contract)).toContain("client or freelancer");
  });
});

describe("classifyReadFailure", () => {
  it("reads a contract NotFound (what a missing escrow returns) as not-found", () => {
    expect(classifyReadFailure(new Error("HostError: Error(Contract, #1)"))).toBe(
      "not-found",
    );
  });

  it("treats an id or address that cannot exist as not-found", () => {
    expect(classifyReadFailure(new Error("Unsupported address type: nope"))).toBe(
      "not-found",
    );
  });

  it("treats transport and configuration failures as unavailable", () => {
    expect(classifyReadFailure(new TypeError("Failed to fetch"))).toBe("unavailable");
    expect(classifyReadFailure(new Error("getaddrinfo ENOTFOUND soroban-testnet"))).toBe(
      "unavailable",
    );
    expect(classifyReadFailure(new Error("RPC request failed (HTTP 503)"))).toBe(
      "unavailable",
    );
    expect(
      classifyReadFailure(new Error("This contract address is not configured (.env)")),
    ).toBe("unavailable");
    // A malformed VITE_*_CONTRACT_ID is a deployment problem, not a bad link.
    expect(classifyReadFailure(new Error("Invalid contract ID: nope"))).toBe(
      "unavailable",
    );
    // NotInitialized: the deployment cannot answer reads yet.
    expect(classifyReadFailure(new Error("HostError: Error(Contract, #12)"))).toBe(
      "unavailable",
    );
    expect(classifyReadFailure(new Error("HostError: Error(Contract, #3)"), "dispute")).toBe("unavailable");
    expect(classifyReadFailure(new Error("HostError: Error(Contract, #3)"), "reputation")).toBe("unavailable");
    expect(classifyReadFailure(new Error("HostError: Error(Contract, #12)"), "reputation")).toBe("unknown");
  });

  it("leaves other contract errors as unknown so the message is shown", () => {
    expect(classifyReadFailure(new Error("HostError: Error(Contract, #3)"))).toBe(
      "unknown",
    );
    expect(classifyReadFailure(new Error("something else"))).toBe("unknown");
  });

  it("passes an existing ContractReadError's kind through", () => {
    expect(classifyReadFailure(new ContractReadError("unavailable", "nope"))).toBe(
      "unavailable",
    );
  });
});

describe("asReadError", () => {
  it("keeps an existing ContractReadError untouched", () => {
    const original = new ContractReadError("not-found", "nope");
    expect(asReadError(original)).toBe(original);
  });

  it("wraps a raw failure with its kind and a friendly message", () => {
    const error = asReadError(new Error("HostError: Error(Contract, #1)"));
    expect(error).toBeInstanceOf(ContractReadError);
    expect(error.kind).toBe("not-found");
    expect(error.message).toMatch(/could not be found/);
  });
});

describe("describeReadFailure", () => {
  it("blames the link only for a missing record", () => {
    expect(describeReadFailure("not-found", "job #7")).toMatch(/check the link/);
  });

  it("calls an unreachable network a network problem, not a bad link", () => {
    const copy = describeReadFailure("unavailable", "job #7");
    expect(copy).toMatch(/Couldn't reach Stellar/);
    expect(copy).toMatch(/not a bad link/);
  });

  it("names the subject that could not be read", () => {
    expect(describeReadFailure("unknown", "this reputation")).toContain(
      "this reputation",
    );
  });
});
