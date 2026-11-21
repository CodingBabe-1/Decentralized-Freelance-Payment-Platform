/**
 * escrowArgs.ts
 *
 * Explicit ScVal construction for the escrow contract's `create` and `update_milestones` calls.
 * Canonical implementation now lives in @stellar-freelance/sdk (packages/sdk) and is re-exported here.
 */

export type {
  MilestoneArg,
  CreateArgsInput,
  UpdateMilestonesArgsInput,
} from "./sdk/types";

export {
  milestoneToScVal,
  milestonesToScVal,
} from "./sdk/scval";

export {
  buildCreateArgs,
  buildUpdateMilestonesArgs,
} from "./sdk/builders";
