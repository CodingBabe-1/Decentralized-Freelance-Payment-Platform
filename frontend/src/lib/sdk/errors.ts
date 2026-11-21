/** `EscrowError` discriminants from contracts/interface/src/lib.rs (1–22). */
export const ESCROW_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  1: "This escrow could not be found.",
  2: "This action is not allowed in the escrow's current state.",
  3: "You're not authorized to perform this action.",
  4: "This milestone has already been released.",
  5: "That milestone index is out of range.",
  6: "This escrow hasn't reached its expiry yet.",
  7: "Enter an amount greater than zero.",
  8: "The milestone list is invalid.",
  9: "Choose a valid expiry time.",
  10: "The client and freelancer must be different addresses.",
  11: "This escrow contract is already initialized.",
  12: "This escrow contract isn't initialized yet.",
  13: "The payout shares must match the remaining escrow balance.",
  14: "The amount is too large to process.",
  15: "That amount is more than what's left on the milestone.",
  16: "The dispute timeout hasn't been reached yet.",
  17: "You can create at most 20 milestones.",
  18: "The dispute timeout must be greater than zero.",
  19: "Escrow actions are temporarily paused.",
  20: "There is no pending dispute contract change.",
  21: "The dispute contract change is still timelocked.",
  22: "The dispute contract address is invalid.",
};

/** `DisputeError` discriminants from contracts/dispute/src/lib.rs (1–14). */
export const DISPUTE_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  1: "This dispute could not be found.",
  2: "This dispute contract is already initialized.",
  3: "This dispute contract isn't initialized yet.",
  4: "This action is not allowed in the dispute's current state.",
  5: "A dispute has already been raised for this escrow.",
  6: "This escrow could not be found.",
  7: "The escrow isn't disputed, so open the escrow dispute before raising it here.",
  8: "Only the client or freelancer can raise this dispute.",
  9: "The proposed payout does not match the remaining escrow balance.",
  10: "The amount is too large to process.",
  11: "The arbitrator panel is invalid.",
  12: "The approval threshold is invalid.",
  13: "Not enough arbitrators have approved this payout.",
  14: "Dispute actions are temporarily paused.",
};

/** `ReputationError` discriminants from contracts/reputation/src/lib.rs (1–10). */
export const REPUTATION_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  1: "This rating could not be found.",
  2: "This reputation contract is already initialized.",
  3: "This reputation contract isn't initialized yet.",
  4: "The score must be between 1 and 5.",
  5: "You have already rated this job.",
  6: "This escrow could not be found.",
  7: "The job must be completed before it can be rated.",
  8: "Only participants in this job can leave a rating.",
  9: "You can only rate the other participant in the job.",
  10: "The amount is too large to process.",
};

/** Extract the `#N` discriminant from a Soroban contract error string, if present. */
export function parseContractErrorCode(message: string): number | null {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(message);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : null;
}

/**
 * Map a Soroban simulation host error (e.g. `HostError: Error(Contract, #5)`) to a human-readable explanation.
 */
export function friendlyContractError(
  message: string,
  messages: Readonly<Record<number, string>> = ESCROW_ERROR_MESSAGES,
): string {
  const code = parseContractErrorCode(message);
  if (code !== null && code in messages) {
    return messages[code];
  }
  return message;
}
