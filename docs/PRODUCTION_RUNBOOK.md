# Production Deployment Runbook & Operational Guide

This runbook defines the comprehensive operational procedures, security checklists, architecture requirements, and post-deployment validation steps required to safely launch and operate the **Stellar Freelance Payment Platform** on **Stellar Mainnet (Public Network)**.

---

## 1. Network & Infrastructure Architecture

| Layer | Provider / Target | Configuration Requirements |
|---|---|---|
| **Network** | Stellar Public Network (`Public Global Stellar Network ; September 2015`) | Passphrase: `Public Global Stellar Network ; September 2015` |
| **Contracts** | Soroban Runtime v22+ (`wasm32v1-none`) | Admin multisig required; upgrade authorization restricted |
| **Backend API** | High-availability container cluster (Render / Railway / Fly.io / AWS ECS) | Minimum 2 replicas, Tini PID 1 init, 15s graceful drain timeout |
| **Database** | Managed PostgreSQL 15+ (AWS RDS / Neon / Supabase) | Multi-AZ standby, daily automated backups, connection pooling (PgBouncer) |
| **Event Indexer** | Dedicated long-running backend process | Persistent DB cursor tracking, dead-letter storage, staleness monitoring |
| **Frontend** | Edge CDN (Vercel / Cloudflare Pages) | Immutable cache on hashed assets, strict CSP and HSTS headers |

---

## 2. Canonical Mainnet Asset Contract Addresses

Smart contracts handle financial milestone settlements. Only audited, canonical Stellar Asset Contracts (SACs) issued by verified entities must be used:

### Official Circle USDC (Stellar Mainnet)
- **Asset Code:** `USDC`
- **Issuer Account:** `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
- **SAC Contract ID:** `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
- **Decimals:** 7
- **Explorer:** <https://stellar.expert/explorer/public/asset/USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN>

### Native Lumens (XLM) SAC
- **Asset Code:** `native`
- **SAC Contract ID:** `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2SLH34XYZDO`
- **Decimals:** 7
- **Explorer:** <https://stellar.expert/explorer/public/asset/XLM>

> [!CAUTION]
> Never substitute custom or unverified token contract wrappers in production. Always verify contract IDs against Circle's official documentation and Stellar.expert.

---

## 3. Pre-Flight Security & Operational Checklist

Before issuing any mainnet transactions or deploying production services, ensure every item below is completed and verified:

- [ ] **Smart Contract Audit:** Independent third-party security audit completed for `contracts/escrow`, `contracts/dispute`, and `contracts/reputation`.
- [ ] **Admin Multi-Sig Setup:** No single private key holds administrative authority. Master admin key weight is set to 0, replaced by an M-of-N multisig panel (e.g. 2-of-3 or 3-of-5) using hardware signers (Ledger).
- [ ] **Bytecode Determinism:** Contracts are built inside a reproducible Docker environment matching the audited Git commit hash (`stellar contract build`).
- [ ] **Soroban RPC High Availability:** Multiple RPC endpoints configured with automatic failover (primary: dedicated RPC node / QuickNode; fallback: SDF public endpoint).
- [ ] **Database Encryption & Backups:** PostgreSQL storage encryption at rest (AES-256), point-in-time recovery (PITR) enabled with 7-day retention.
- [ ] **SSL / TLS Termination:** Valid TLS 1.3 certificates enforced with HTTP Strict Transport Security (`Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`).
- [ ] **CORS Origin Restriction:** `CORS_ORIGIN` environment variable locked to production frontend domain(s). Unrestricted wildcard (`*`) is strictly disallowed.
- [ ] **Rate Limiting:** IP-based and route-specific rate limiting active on `/api/users/challenge`, `/api/users/auth`, and global endpoints.
- [ ] **Secrets Management:** Environment secrets (`DATABASE_URL`, `JWT_SECRET`) injected via secure secret managers (AWS Secrets Manager, HashiCorp Vault, or Doppler). No secrets in Git.
- [ ] **Observability & Alerting:** Sentry/Datadog monitoring configured for unhandled exceptions, indexer cursor lag, and contract configuration drift warnings.

---

## 4. Multi-Sig Admin Governance Configuration

The `escrow`, `dispute`, and `reputation` contracts each require an `admin` address upon initialization. In production, this must be a multi-signature account.

### Configuring a 2-of-3 Admin Account on Stellar

```bash
# 1. Generate or import three separate hardware key addresses:
# KEY_1 (Operations Lead), KEY_2 (Engineering Lead), KEY_3 (Security Auditor)

# 2. Establish account thresholds on the primary Admin account (ADMIN_PUBKEY):
stellar tx set-options \
  --source-account ADMIN_SECRET \
  --master-weight 10 \
  --low-threshold 20 \
  --medium-threshold 20 \
  --high-threshold 20 \
  --network mainnet

# 3. Add signer keys with weight 10 each:
stellar tx set-options \
  --source-account ADMIN_SECRET \
  --signer KEY_1 --signer-weight 10 \
  --network mainnet

stellar tx set-options \
  --source-account ADMIN_SECRET \
  --signer KEY_2 --signer-weight 10 \
  --network mainnet

stellar tx set-options \
  --source-account ADMIN_SECRET \
  --signer KEY_3 --signer-weight 10 \
  --network mainnet

# 4. Remove master key weight to eliminate single-point-of-failure:
stellar tx set-options \
  --source-account ADMIN_SECRET \
  --master-weight 0 \
  --network mainnet
```

Any future administrative operations (such as rotating the arbitrator panel or setting dispute timeouts) will require 2 out of 3 signatures.

---

## 5. Mainnet Deployment Procedure

### Phase 1: Build & Deploy Smart Contracts

```bash
# Ensure Rust and target are installed
rustup target add wasm32v1-none

# 1. Build release binaries
stellar contract build

# 2. Inspect and record wasm bytecode hashes
ESCROW_HASH=$(stellar contract install --wasm contracts/target/wasm32v1-none/release/escrow.wasm --network mainnet)
DISPUTE_HASH=$(stellar contract install --wasm contracts/target/wasm32v1-none/release/dispute.wasm --network mainnet)
REPUTATION_HASH=$(stellar contract install --wasm contracts/target/wasm32v1-none/release/reputation.wasm --network mainnet)

echo "Escrow Wasm Hash: $ESCROW_HASH"
echo "Dispute Wasm Hash: $DISPUTE_HASH"
echo "Reputation Wasm Hash: $REPUTATION_HASH"

# 3. Deploy contract instances
ESCROW_ID=$(stellar contract deploy --wasm-hash "$ESCROW_HASH" --network mainnet)
DISPUTE_ID=$(stellar contract deploy --wasm-hash "$DISPUTE_HASH" --network mainnet)
REPUTATION_ID=$(stellar contract deploy --wasm-hash "$REPUTATION_HASH" --network mainnet)

# 4. Initialize contracts
# Escrow: init(admin, dispute_contract)
stellar contract invoke --id "$ESCROW_ID" --network mainnet -- init \
  --admin "$ADMIN_MULTISIG" \
  --dispute_contract "$DISPUTE_ID"

# Dispute: init(admin, arbitrators, threshold)
stellar contract invoke --id "$DISPUTE_ID" --network mainnet -- init \
  --admin "$ADMIN_MULTISIG" \
  --arbitrators "[\"$ARB_1\",\"$ARB_2\",\"$ARB_3\"]" \
  --threshold 2

# Reputation: init(admin, escrow_contract)
stellar contract invoke --id "$REPUTATION_ID" --network mainnet -- init \
  --admin "$ADMIN_MULTISIG" \
  --escrow_contract "$ESCROW_ID"

# 5. Record IDs in deployments/mainnet.json
cat <<EOF > deployments/mainnet.json
{
  "network": "mainnet",
  "escrow_contract_id": "$ESCROW_ID",
  "dispute_contract_id": "$DISPUTE_ID",
  "reputation_contract_id": "$REPUTATION_ID",
  "usdc_contract_id": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  "xlm_contract_id": "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2SLH34XYZDO"
}
EOF
```

### Phase 2: Deploy Production Backend

1. **Database Migrations:**
   ```bash
   npx prisma migrate deploy
   ```
2. **Configure Environment Variables:**
   - `PORT=3000`
   - `NODE_ENV=production`
   - `STELLAR_NETWORK=mainnet`
   - `DATABASE_URL=postgresql://...`
   - `JWT_SECRET=<32+ character random secret>`
   - `SOROBAN_RPC_URL=https://soroban-mainnet.stellar.org` (or dedicated RPC provider)
   - `ESCROW_CONTRACT_ID=$ESCROW_ID`
   - `DISPUTE_CONTRACT_ID=$DISPUTE_ID`
   - `REPUTATION_CONTRACT_ID=$REPUTATION_ID`
   - `USDC_CONTRACT_ID=CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
   - `XLM_CONTRACT_ID=CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2SLH34XYZDO`
   - `ARBITRATOR_ADDRESSES=$ARB_1,$ARB_2,$ARB_3`
   - `CORS_ORIGIN=https://app.yourdomain.com`
   - `TRUST_PROXY=1`
3. **Start Container:**
   Verify container boots with PID 1 `tini` init process and logs contract configuration freshness confirmation.

### Phase 3: Deploy Production Frontend

1. Configure Vercel / Cloudflare Pages environment variables:
   - `VITE_NETWORK=mainnet`
   - `VITE_API_URL=https://api.yourdomain.com`
   - `VITE_ESCROW_CONTRACT_ID=$ESCROW_ID`
   - `VITE_DISPUTE_CONTRACT_ID=$DISPUTE_ID`
   - `VITE_REPUTATION_CONTRACT_ID=$REPUTATION_ID`
   - `VITE_USDC_CONTRACT_ID=CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
2. Build and verify code-split chunks:
   ```bash
   npm run build
   ```
3. Deploy to production domain.

---

## 6. Automated Post-Deployment Smoke Testing

Run the automated smoke test suite against the live deployment to confirm health, contract bytecode matches, CORS rules, and API endpoints:

```bash
# Execute against live deployment
./scripts/smoke_test.sh --url https://api.yourdomain.com --cors https://app.yourdomain.com
```

The smoke test validates:
- `GET /health` answers HTTP 200 with `{ status: "ok", db: true, indexer: true }`.
- Event indexer cursor is actively processing recent ledgers.
- Contract configuration sync verification reports no drift between environment and on-chain views.
- Strict CORS origin enforcement and preflight `OPTIONS` headers.
- Public taxonomies (`GET /api/jobs/tags`) and Swagger OpenAPI docs are accessible.

---

## 7. Incident Response & Emergency Procedures

### 1. Contract Configuration Drift Alert
If the backend logs `[config] Critical contract configuration drift detected`:
1. Check whether governance rotated the arbitrator panel or dispute contract on-chain.
2. Update backend `ARBITRATOR_ADDRESSES` and `DISPUTE_CONTRACT_ID` in production environment settings.
3. Restart backend service instances to re-verify synchronization.

### 2. Soroban RPC Outage / Rate Limit
If primary RPC drops requests or lags:
1. Update `SOROBAN_RPC_URL` to failover provider (e.g. Blockdaemon, QuickNode).
2. The indexer will pick up from the last processed ledger recorded in `IndexerCursor`.

### 3. Compromised Arbitrator Key
If an arbitrator's private key is leaked:
1. Initiate emergency multisig transaction to invoke `dispute.remove_arbitrator(compromised)` (lower the threshold with `dispute.set_threshold` first if the panel would fall below it), then `dispute.add_arbitrator(replacement)`. Only the admin signs; the other arbitrators do not need to. `dispute.set_panel(new_arbitrators, new_threshold)` replaces the whole panel in one call.
2. Update `ARBITRATOR_ADDRESSES` on backend services.
3. Any open disputes will require approvals from the newly authorized panel.

### 4. Critical Contract Bug / Required Bytecode Upgrade
Escrow and Dispute expose an admin-only `set_code(new_wasm_hash)` that swaps the
contract bytecode in place. The contract address and all storage are preserved,
so active escrows and held funds are unaffected.
1. Pause the contract: `stellar contract invoke --id "$ESCROW_ID" --network mainnet -- pause`.
2. Build and install the fixed Wasm: `NEW_HASH=$(stellar contract install --wasm contracts/target/wasm32v1-none/release/escrow.wasm --network mainnet)`.
3. Invoke `set_code --new_wasm_hash "$NEW_HASH"` via the admin multisig (same for `dispute`).
4. Verify with a read call (e.g. `get`) and the `code_updated` event, then `unpause`.
