# Troubleshooting Guide

This guide covers common Soroban simulation errors, smart contract failure codes, Freighter wallet connection issues, and RPC connectivity problems on the Stellar Freelance Payment Platform.

---

## Table of Contents

- [Understanding Soroban Errors](#understanding-soroban-errors)
- [Smart Contract Error Reference Tables](#smart-contract-error-reference-tables)
  - [Escrow Contract Errors (`EscrowError`)](#escrow-contract-errors-escrowerror)
  - [Dispute Contract Errors (`DisputeError`)](#dispute-contract-errors-disputeerror)
  - [Reputation Contract Errors (`ReputationError`)](#reputation-contract-errors-reputationerror)
- [Freighter Wallet Connection & Signing Issues](#freighter-wallet-connection--signing-issues)
  - [Network Mismatch (Testnet vs Mainnet)](#network-mismatch-testnet-vs-mainnet)
  - [Freighter Not Detected (`window.freighterApi` undefined)](#freighter-not-detected-windowfreighterapi-undefined)
  - [Transaction Signature Rejected / Aborted](#transaction-signature-rejected--aborted)
- [Stellar Horizon & Soroban RPC Errors](#stellar-horizon--soroban-rpc-errors)
  - [RPC Simulation Failures & HostError](#rpc-simulation-failures--hosterror)
  - [Account Underfunded / Minimum Reserve (`op_underfunded`)](#account-underfunded--minimum-reserve-op_underfunded)
  - [Missing Trustline (`op_no_trust`)](#missing-trustline-op_no_trust)
  - [Sequence Number Desynchronization (`tx_bad_seq`)](#sequence-number-desynchronization-tx_bad_seq)
  - [RPC Timeouts & 504 Gateway Timeout](#rpc-timeouts--504-gateway-timeout)
- [Backend Indexer & Database Troubleshooting](#backend-indexer--database-troubleshooting)
  - [Stale Indexer Cursor / Unindexed Events](#stale-indexer-cursor--unindexed-events)
  - [Database Query Execution Timeouts (504)](#database-query-execution-timeouts-504)
  - [Dead-Letter Queue Inspection (`IndexerDeadLetter`)](#dead-letter-queue-inspection-indexerdeadletter)

---

## Understanding Soroban Errors

When a transaction fails simulation or on-chain execution, Soroban surfaces a diagnostic message formatted as:

```text
HostError: Error(Contract, #N)
```

Where `#N` corresponds to the integer discriminant of the contract's custom error enum:
- `#N` in `escrow` calls maps to [`EscrowError`](#escrow-contract-errors-escrowerror).
- `#N` in `dispute` calls maps to [`DisputeError`](#dispute-contract-errors-disputeerror).
- `#N` in `reputation` calls maps to [`ReputationError`](#reputation-contract-errors-reputationerror).

> [!IMPORTANT]
> Error discriminants overlap across contracts (for example, code `#7` is `ZeroAmount` in `EscrowError`, but `EscrowNotDisputed` in `DisputeError`). Always inspect the specific contract being called.

---

## Smart Contract Error Reference Tables

### Escrow Contract Errors (`EscrowError`)

Source: `contracts/interface/src/lib.rs`

| Code | Error Name | Root Cause | Remediation / Fix |
|---|---|---|---|
| `#1` | `NotFound` | The requested `escrow_id` does not exist on-chain. | Verify that `escrow.create()` completed successfully and that the correct `escrowId` is provided. |
| `#2` | `InvalidStatus` | The escrow is not in a valid state for this action. | Milestones can only be edited when status is `Created` (before funding). Funding requires status `Created`. Releases require status `Funded`. |
| `#3` | `Unauthorized` | The caller's address is not authorized for this action. | Only the client can update milestones or release funds. Ensure the signing wallet matches the job's `client` address. |
| `#4` | `MilestoneAlreadyReleased` | The milestone has already been released in full. | Check `job.milestones` state; milestones cannot be released multiple times. |
| `#5` | `MilestoneIndexOutOfBounds` | The specified milestone index exceeds the milestone list length. | Milestones are 0-indexed (`0` to `total_milestones - 1`). Verify index bounds. |
| `#6` | `NotExpired` | Attempted to call `reclaim_expired` before the expiry timestamp. | Funds can only be reclaimed after the safety timelock has passed without activity. |
| `#7` | `ZeroAmount` | A milestone amount or release amount is zero or negative. | All payment amounts must be strictly greater than zero. |
| `#8` | `InvalidMilestones` | The milestone array is empty or contains zero milestones. | An escrow must contain at least one milestone. |
| `#9` | `InvalidExpiry` | The safety expiry timestamp is set in the past or is invalid. | Provide a UNIX timestamp (seconds) strictly in the future. |
| `#10` | `InvalidCounterparty` | Client and freelancer addresses are identical. | The client and freelancer must be distinct Stellar accounts. |
| `#11` | `AlreadyInitialized` | `escrow.init()` was called on an already-initialized contract. | The contract is initialized once upon deployment. |
| `#12` | `NotInitialized` | Contract function called before contract was initialized. | Run `scripts/deploy_testnet.sh` to initialize the contract. |
| `#13` | `InvalidShares` | Dispute resolution shares do not sum to remaining escrow balance. | Ensure `freelancer_share + client_share == remaining_balance`. |
| `#14` | `Overflow` | Numeric overflow occurred during base unit addition or multiplication. | Ensure total values do not exceed 128-bit signed integer limits. |
| `#15` | `AmountExceedsMilestone` | Partial release amount exceeds remaining balance on milestone. | Requested release amount must be `<= milestone.amount - milestone.releasedAmount`. |
| `#16` | `DisputeTimeoutNotReached` | Timelocked dispute escape hatch invoked before 7-day timeout. | Client can only execute `reclaim_after_dispute_timeout` after 7 days have passed since the dispute was opened. |
| `#17` | `TooManyMilestones` | More than 20 milestones submitted for a single escrow. | Consolidate deliverables into 20 or fewer milestones (`MAX_MILESTONES = 20`). |
| `#18` | `InvalidDisputeTimeout` | Configured dispute timeout is zero. | Timeout must be positive (defaults to 7 days = 604,800 seconds). |
| `#19` | `Paused` | Escrow contract operations are temporarily paused by admin. | Await unpause by the platform administrator. |
| `#20` | `NoPendingDisputeContract` | `apply_dispute_contract` or `cancel_dispute_contract_change` called with no pending rotation. | Call `set_dispute_contract` first to propose a new dispute contract. |
| `#21` | `DisputeContractTimelockActive` | `apply_dispute_contract` called before the 2-day timelock elapsed. | Wait until the proposal's `effective_at` timestamp (see `pending_dispute_contract`). |
| `#22` | `InvalidDisputeContract` | `init` or `set_dispute_contract` given an account (`G...`) address, the zero contract address, the admin, or the escrow contract itself. | Pass the deployed dispute contract's `C...` address. |

---

### Dispute Contract Errors (`DisputeError`)

Source: `contracts/dispute/src/lib.rs`

| Code | Error Name | Root Cause | Remediation / Fix |
|---|---|---|---|
| `#1` | `NotFound` | The requested dispute record does not exist. | Ensure the dispute was opened on the escrow contract first. |
| `#2` | `AlreadyInitialized` | `dispute.init()` called more than once. | Dispute contract is already initialized. |
| `#3` | `NotInitialized` | Dispute contract invoked before initialization. | Run `dispute.init(admin, escrow_contract, panel, threshold)`. |
| `#4` | `InvalidStatus` | Action invalid for current dispute state. | Cannot re-arbitrate a dispute that is already in `Resolved` or `Refunded` status. |
| `#5` | `AlreadyRaised` | A dispute is already raised for this escrow. | Each escrow can only have one active dispute. |
| `#6` | `EscrowNotFound` | Dispute contract called cross-contract `escrow.get()` and received `NotFound`. | Verify that the escrow contract id matches and the escrow exists. |
| `#7` | `EscrowNotDisputed` | Escrow is not in `DISPUTED` status. | Call `escrow.open_dispute()` before calling `dispute.raise()`. |
| `#8` | `Unauthorized` | Caller is not a participant (client/freelancer) or not on arbitrator panel. | Only dispute participants can raise; only configured arbitrators can arbitrate. |
| `#9` | `EscrowRejected` | The escrow contract rejected the proposed resolution split. | Verify that resolution shares match the held balance on the escrow contract. |
| `#10` | `Overflow` | Numeric overflow in share calculations. | Check integer values. |
| `#11` | `InvalidPanel` | Arbitrator panel address list is empty or contains duplicates. | Specify 1 to 10 unique arbitrator addresses. |
| `#12` | `InvalidThreshold` | Approval threshold `M` is zero or exceeds panel size `N`. | Set `1 <= M <= N`. |
| `#13` | `InsufficientApprovals` | Threshold of required arbitrator approvals has not been met. | Gather sufficient arbitrator approval votes before finalizing resolution. |
| `#14` | `Paused` | Dispute contract is paused. | Await contract unpause. |

---

### Reputation Contract Errors (`ReputationError`)

Source: `contracts/reputation/src/lib.rs`

| Code | Error Name | Root Cause | Remediation / Fix |
|---|---|---|---|
| `#1` | `NotFound` | Rating record does not exist. | Verify rating parameters. |
| `#2` | `AlreadyInitialized` | Reputation contract already initialized. | Contract initialization is one-time. |
| `#3` | `NotInitialized` | Reputation contract invoked before initialization. | Initialize contract with admin and trusted escrow contract address. |
| `#4` | `InvalidScore` | Rating score outside 1–5 range. | Scores must be an integer from 1 to 5. |
| `#5` | `AlreadyRated` | Caller has already submitted a rating for this job. | Each participant may only rate the counterparty once per job. |
| `#6` | `EscrowNotFound` | Escrow record not found when verifying job completion. | Ensure the job has a valid associated on-chain escrow ID. |
| `#7` | `EscrowNotCompleted` | Job escrow has not reached `Completed` state. | Ratings are only unlocked after all milestones are released or resolved. |
| `#8` | `Unauthorized` | Caller was neither the client nor freelancer on the job. | Only confirmed job participants can submit ratings. |
| `#9` | `InvalidRatee` | User attempted to rate themselves or an unrelated party. | Client must rate freelancer; freelancer must rate client. |
| `#10` | `Overflow` | Numeric overflow during aggregate weighting calculation. | Verify rating calculations. |

---

## Freighter Wallet Connection & Signing Issues

### Network Mismatch (Testnet vs Mainnet)
- **Symptom:** Transactions fail simulation with `HostError` or contract not found; DApp displays a red network warning banner.
- **Cause:** The platform operates on **Stellar Testnet** (`Test SDF Network ; September 2015`), but Freighter is connected to Public/Mainnet.
- **Solution:**
  1. Open the Freighter browser extension.
  2. Click the network dropdown in the top-right corner.
  3. Select **Testnet**.
  4. Reload the DApp page.

### Freighter Not Detected (`window.freighterApi` undefined)
- **Symptom:** Clicking "Connect Wallet" does nothing, or alerts "Freighter extension not found".
- **Cause:** The Freighter extension is not installed or third-party script injection is blocked.
- **Solution:**
  1. Install Freighter from [freighter.app](https://www.freighter.app).
  2. Ensure extension permissions allow access to `localhost` or the hosted DApp origin.
  3. Hard refresh the page (`Ctrl + Shift + R` or `Cmd + Shift + R`).

### Transaction Signature Rejected / Aborted
- **Symptom:** Prompt closes with `User declined transaction signing`.
- **Cause:** The user clicked "Reject" in the Freighter popup, or popup timed out.
- **Solution:** Re-trigger the action from the UI and click "Approve" within the Freighter modal.

---

## Stellar Horizon & Soroban RPC Errors

### Account Underfunded / Minimum Reserve (`op_underfunded`)
- **Symptom:** Transaction submission fails with `tx_failed` and operation result `op_underfunded`.
- **Cause:** The account has insufficient XLM to meet Stellar's base reserve (1 XLM minimum + 0.5 XLM per trustline / contract entry + transaction fee).
- **Solution:**
  1. Fund the account using the Stellar Testnet Friendbot:
     ```bash
     curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"
     ```
  2. Ensure your account retains at least 5–10 XLM buffer above milestone payment commitments.

### Missing Trustline (`op_no_trust`)
- **Symptom:** Milestone payments in USDC fail with `op_no_trust`.
- **Cause:** The destination account has not established a trustline for the asset SAC.
- **Solution:** Establish a trustline for the payment token before accepting assignments or releases.

### Sequence Number Desynchronization (`tx_bad_seq`)
- **Symptom:** Submission fails with `tx_bad_seq`.
- **Cause:** Multiple transactions submitted in rapid succession using the same source account sequence number.
- **Solution:** Refetch current sequence from Horizon/RPC before building and submitting the next transaction.

### RPC Timeouts & 504 Gateway Timeout
- **Symptom:** `504 Gateway Timeout` or `FetchError: request timed out`.
- **Cause:** Public Stellar testnet RPC nodes experiencing temporary congestion.
- **Solution:**
  1. Retry with exponential backoff (1s, 2s, 4s).
  2. If using a custom RPC, ensure `SOROBAN_RPC_URL` is healthy and responsive.

---

## Backend Indexer & Database Troubleshooting

### Stale Indexer Cursor / Unindexed Events
- **Symptom:** Chain transactions confirm on-chain, but the backend UI does not reflect status changes.
- **Diagnostics:**
  1. Query backend health: `GET /health`
  2. If `indexer: false` or `status: "degraded"`, the cursor has lagged behind the chain tip.
- **Solution:**
  - Verify `ESCROW_CONTRACT_ID`, `DISPUTE_CONTRACT_ID`, and `REPUTATION_CONTRACT_ID` in `backend/.env` match `deployments/testnet.json`.
  - Check that the indexer process is active. Restart the backend if it was paused.

### Database Query Execution Timeouts (504)
- **Symptom:** API endpoints return `504 Gateway Timeout` with `{ "error": "Gateway Timeout" }`.
- **Cause:** A database statement exceeded the 10-second statement timeout (`QUERY_TIMEOUT_MS = 10000`).
- **Remediation:**
  - Inspect backend logs for `[slow_query]` warnings exceeding 1,000ms.
  - Optimize queries with missing indexes or reduce pagination `limit` parameter.

### Dead-Letter Queue Inspection (`IndexerDeadLetter`)
- **Symptom:** Log warning: `[indexer] dead-letters a failing event`.
- **Cause:** An event on-chain could not be applied to the PostgreSQL database (e.g. payload schema mismatch or foreign key constraint).
- **Remediation:**
  - Query the dead-letter table:
    ```sql
    SELECT * FROM "IndexerDeadLetter" ORDER BY "createdAt" DESC LIMIT 10;
    ```
  - Replay failed events or apply required database migrations.
