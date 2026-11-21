import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { MilestoneArg } from "./types";

export const scAddress = (address: string): xdr.ScVal =>
  Address.fromString(address).toScVal();

export const scU32 = (n: number): xdr.ScVal =>
  nativeToScVal(n, { type: "u32" });

export const scU64 = (n: number | bigint): xdr.ScVal =>
  nativeToScVal(n, { type: "u64" });

export const scI128 = (n: number | bigint): xdr.ScVal =>
  nativeToScVal(n, { type: "i128" });

export const scString = (value: string): xdr.ScVal =>
  nativeToScVal(value, { type: "string" });

export const scSymbol = (name: string): xdr.ScVal =>
  nativeToScVal(name, { type: "symbol" });

export const scBool = (val: boolean): xdr.ScVal =>
  nativeToScVal(val, { type: "bool" });

/**
 * Encode one milestone as the contract's `Milestone` struct.
 *
 * Map entries are emitted in ascending key order (amount, deadline, released, released_amount)
 * to strictly adhere to the Soroban runtime canonical struct serialization.
 */
export function milestoneToScVal(m: MilestoneArg): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("amount"),
      val: scI128(m.amount),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("deadline"),
      val: scU64(m.deadline),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("released"),
      val: xdr.ScVal.scvBool(m.released ?? false),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("released_amount"),
      val: scI128(m.releasedAmount ?? 0n),
    }),
  ]);
}

/** Encode a list of milestones as the contract's `Vec<Milestone>`. */
export function milestonesToScVal(milestones: MilestoneArg[]): xdr.ScVal {
  return xdr.ScVal.scvVec(milestones.map(milestoneToScVal));
}
