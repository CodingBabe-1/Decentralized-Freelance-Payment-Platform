# @stellar-freelance/sdk

Typed TypeScript SDK for Stellar Freelance Soroban contracts (Escrow, Dispute, and Reputation).

## Features
- **Typed ScVal Encoders**: Canonical ScVal construction for `Address`, `u32`, `u64`, `i128`, `string`, and `Milestone` vectors.
- **Contract Call Builders**: Pre-built invocation argument builders matching contract ABIs.
- **Typed Contract Clients**: `EscrowClient`, `DisputeClient`, and `ReputationClient` for building contract calls.
- **Contract Error Parsers**: Human-readable translation for on-chain Soroban `HostError: Error(Contract, #N)` failure codes.
- **TypeScript Types**: Complete type definitions for milestones, escrow status, dispute states, and reputation metrics.

## Installation
```bash
npm install @stellar-freelance/sdk
```

## Usage
```typescript
import {
  EscrowClient,
  buildFundArgs,
  milestonesToScVal,
  parseContractErrorCode,
  friendlyContractError,
} from "@stellar-freelance/sdk";

// Encode milestones
const milestonesVal = milestonesToScVal([
  { amount: 10000000n, deadline: 1735689600n },
]);

// Build client invocation
const client = new EscrowClient("CALNRFGMUI7MLNLWO445U2BSDENF6DENURHXXFFRT6PV5GSOQX7GZGP7");
const fundCall = client.fund(42n);
```
