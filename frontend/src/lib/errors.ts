/** Friendly, contract-specific Soroban errors. Keep these codes aligned with the Rust enums. */
export type ContractErrorContract = "escrow" | "dispute" | "reputation";

/** Unknown SDK errors and unrecognized contract codes must not leak raw host/stack details. */
export const UNKNOWN_ERROR_MESSAGE = "Something went wrong. Please try again.";

/** contracts/interface/src/lib.rs: EscrowError (1–22). */
const ESCROW_ERROR_MESSAGES: Readonly<Record<number, string>> = {
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

/** contracts/dispute/src/lib.rs: DisputeError (1–14). */
const DISPUTE_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  1: "This dispute could not be found.",
  2: "This dispute contract is already initialized.",
  3: "This dispute contract isn't initialized yet.",
  4: "This action is not allowed in the dispute's current state.",
  5: "A dispute has already been raised for this escrow.",
  6: "This escrow could not be found.",
  7: "Open the escrow dispute before raising it here.",
  8: "Only the client or freelancer can raise this dispute.",
  9: "The proposed payout does not match the remaining escrow balance.",
  10: "The amount is too large to process.",
  11: "The arbitrator panel is invalid.",
  12: "The approval threshold is invalid.",
  13: "Not enough arbitrators have approved this payout.",
  14: "Dispute actions are temporarily paused.",
};

/** contracts/reputation/src/lib.rs: ReputationError (1–10). */
const REPUTATION_ERROR_MESSAGES: Readonly<Record<number, string>> = {
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

const CONTRACT_MESSAGES: Record<ContractErrorContract, Readonly<Record<number, string>>> = {
  escrow: ESCROW_ERROR_MESSAGES,
  dispute: DISPUTE_ERROR_MESSAGES,
  reputation: REPUTATION_ERROR_MESSAGES,
};

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "";
  }
}

/** Extract the #N discriminant only from the Soroban contract-error pattern. */
export function parseContractErrorCode(message: string): number | null {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(message);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : null;
}

/** Preserve the contract that rejected a write, including two-step dispute flows. */
export class ContractCallError extends Error {
  readonly contract: ContractErrorContract;

  constructor(error: unknown, contract: ContractErrorContract) {
    super(rawMessage(error));
    this.name = "ContractCallError";
    this.contract = contract;
  }
}

/**
 * Convert raw SDK errors to safe UI copy. Code numbers overlap across
 * contracts, so callers must pass the contract that actually returned it.
 * Never display unrecognized SDK text or stack traces, and never throw.
 */
export function friendlyError(error: unknown, contract: ContractErrorContract = "escrow"): string {
  const raw = rawMessage(error);
  const code = parseContractErrorCode(raw);
  if (code !== null) return CONTRACT_MESSAGES[contract][code] ?? UNKNOWN_ERROR_MESSAGE;

  if (/^wallet not connected$/i.test(raw.trim())) return "Connect your wallet and try again.";
  if (/^(?:user |request )?(?:rejected|declined|denied)(?: (?:the )?(?:request|transaction|signature))?\.?$/i.test(raw.trim())) {
    return "The wallet request was cancelled.";
  }
  if (/^(?:failed to fetch|fetch failed|network error)$/i.test(raw.trim())) {
    return "Could not connect. Check your connection and try again.";
  }
  return UNKNOWN_ERROR_MESSAGE;
}

// ---------------------------------------------------------------------------
// Read failures
// ---------------------------------------------------------------------------

/**
 * Why a public read failed, at the level of detail a page can act on:
 *
 * - `not-found`   – the contract answered "no such record", or the id/address in
 *                   the URL cannot exist at all. The link is the problem.
 * - `unavailable` – there was no answer to read: RPC/network failure, a missing
 *                   contract id, or an unreadable read-only source account. The
 *                   link is fine; retrying or fixing configuration helps.
 * - `unknown`     – the contract rejected the call for another reason (e.g. it
 *                   is not initialized); show a safe generic message.
 */
export type ReadFailureKind = "not-found" | "unavailable" | "unknown";

/** A read-only contract call that failed, carrying a machine-readable kind. */
export class ContractReadError extends Error {
  readonly kind: ReadFailureKind;

  constructor(kind: ReadFailureKind, message: string) {
    super(message);
    this.name = "ContractReadError";
    this.kind = kind;
  }
}

/** Failures that mean "no usable answer from the network", not "bad record". */
const UNAVAILABLE_PATTERNS = [
  /failed to fetch/i,
  /fetch failed/i,
  /load failed/i,
  /network ?error/i,
  /timed? ?out|timeout/i,
  /econnrefused|econnreset|enotfound|eai_again|socket hang up/i,
  /connection (?:refused|closed|reset)/i,
  /http (?:408|429|5\d\d)/i,
  /not configured/i,
  // A malformed contract id comes from a bad VITE_*_CONTRACT_ID, not a bad link.
  /invalid contract id/i,
];

/** Failures that mean the id/address the caller asked for cannot exist. */
const INVALID_INPUT_PATTERNS = [
  /unsupported address type/i,
  /invalid address/i,
  /invalid strkey/i,
  /invalid public key/i,
];

/**
 * Classify a failed read without hiding it: contract codes win, then SDK input
 * validation, then transport failures; anything else stays `unknown` so its
 * message is surfaced verbatim.
 */
export function classifyReadFailure(
  error: unknown,
  contract: ContractErrorContract = "escrow",
): ReadFailureKind {
  if (error instanceof ContractReadError) return error.kind;
  const raw = rawMessage(error);

  const code = parseContractErrorCode(raw);
  if (code === 1) return "not-found";
  // NotInitialized means this deployment cannot answer reads yet.
  if (code === (contract === "escrow" ? 12 : 3)) return "unavailable";
  if (code !== null) return "unknown";

  if (INVALID_INPUT_PATTERNS.some((re) => re.test(raw))) return "not-found";
  if (UNAVAILABLE_PATTERNS.some((re) => re.test(raw))) return "unavailable";
  return "unknown";
}

/** Normalize anything a read threw into a `ContractReadError`. */
export function asReadError(
  error: unknown,
  contract: ContractErrorContract = "escrow",
): ContractReadError {
  if (error instanceof ContractReadError) return error;
  return new ContractReadError(classifyReadFailure(error, contract), friendlyError(error, contract));
}

/**
 * User-facing copy for a read failure. `subject` is what could not be read,
 * e.g. "job #12" or "this reputation".
 */
export function describeReadFailure(
  kind: ReadFailureKind,
  subject: string,
): string {
  switch (kind) {
    case "not-found":
      return `Couldn't find ${subject}. It may not exist on this network — check the link.`;
    case "unavailable":
      return `Couldn't reach Stellar to read ${subject}. This is a network or configuration problem, not a bad link — try again.`;
    default:
      return `Reading ${subject} failed for an unexpected reason.`;
  }
}
