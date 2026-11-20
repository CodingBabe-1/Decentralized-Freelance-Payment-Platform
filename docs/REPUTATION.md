# Reputation weighting and anti-spam

`reputation.submit` accepts a 1–5 rating once a job is `Completed` and the rater
is a participant. Every raw rating is stored unchanged; the **aggregate** that
`get_aggregate` returns is maintained from those raw ratings by `submit`.

## The rule

For an address, a rating counts toward its aggregate when:

1. **Anti-spam:** each escrow counts once per rater. A rater can rate the same
   ratee on every escrow they complete together, but a second rating for the
   *same* escrow is rejected (`AlreadyRated`). An earlier small job therefore
   never mutes the rating on a later, larger one.
2. **Weighting:** the counted rating is weighted by its escrow's `total_amount`
   **normalized to 7 decimals** (see below). The escrow is read during `submit`,
   which already loads it to verify the job completed; normalizing adds one
   read-only `decimals()` call on the escrow's token.

`get_aggregate` returns:

```rust
Aggregate {
    total_score: u64, // sum(score * weight)
    weight: u64,      // sum(weight)
    count: u64,       // number of counted ratings
}
```

The average is `total_score / weight` (0 when `weight` is 0). `count` is the
number of ratings that counted, so the UI can still show "N review(s)".

This is integer-only (no floating point on-chain). Rounding is left to the
display layer.

## Decimal normalization

Raw `total_amount` is in the token's base units, which are not comparable across
tokens and overflow `u64` for high-precision ones: 100 tokens of an 18-decimal
asset is 10^20, above `u64::MAX` (~1.8 × 10^19), which used to make every
`submit` for such a job fail with `Overflow`. A 10 USDC job (7 decimals, 10^8)
also weighed 10^11 times less than a 10-token job in an 18-decimal asset.

So `submit` reads the escrow token's `decimals()` and converts the amount to
**whole tokens × 10^7** (`WEIGHT_DECIMALS = 7`, the Stellar standard):

| Token decimals | Conversion | 10 whole tokens weigh |
|----------------|------------|-----------------------|
| 18 | `amount / 10^11` | 100,000,000 |
| 7 (USDC, XLM) | unchanged | 100,000,000 |
| 0 | `amount × 10^7` | 100,000,000 |

Details:

- the same whole amount weighs the same in any token, and a `u64` weight holds
  up to ~1.8 × 10^12 whole tokens per escrow;
- for tokens with more than 7 decimals, amounts below 10^-7 of a token truncate;
  a job that truncates to zero weight is stored but not counted, like a
  zero-amount escrow;
- a token that does not answer `decimals()` makes `submit` fail with
  `TokenDecimalsUnavailable` rather than guess a scale;
- weights are *not* converted to a common currency: 10 of a token and 10 of a
  differently priced token still weigh the same. This removes the precision
  distortion, not the price difference.

## The API mirror

`GET /api/reputation/:address` returns the same aggregate the contract stores,
not a plain mean of the `Rating` rows (issue #34). The route folds the rows with
exactly the rule above (the `/ratings` listing beside it stays raw, one row per
review):

- every row counts: rows are unique per `(rater, job)`, the same granularity as
  the `RatingCounted(ratee, rater, escrow_id)` marker;
- each counted row is weighted by `Job.totalAmount` scaled to 7 decimals
  (`WEIGHT_DECIMALS`), the same normalized weight the contract computes;
- a zero-weight row (a zero or sub-10^-7 amount) is not counted, matching the contract's `if weight > 0` guard.

The response extends the previous shape without breaking it:

```json
{
  "address": "G...",
  "averageScore": 3.2,
  "totalScore": "32000000000",
  "weight": "10000000000",
  "count": 2,
  "totalRatings": 2
}
```

`totalScore` and `weight` are the contract's `u64` fields as decimal strings,
so a client can compare them with `get_aggregate` exactly; `averageScore` is
`totalScore / weight` (0 when nothing counted) for display; `count` is the
number of counted ratings, while `totalRatings` remains the number of rows
received, so the profile can still say "N review(s)".

One caveat is inherent to the off-chain mirror: `POST /api/reputation` writes
the `Rating` row before the transaction is submitted, so a row whose
`reputation.submit` never confirmed can be reflected in the API while the chain
has not seen it. The idempotent `(rater, job)` key stops a duplicate, but the
chain remains the source of truth for a settled aggregate.

The freelancer directory (`GET /api/users/freelancers`) still sorts by the raw
mean of the rows; it is a discovery surface, not the aggregate the profile
shows, and is a candidate for the same helper in a follow-up.

## Cost model

Weighting is applied **once, in `submit`**, not recomputed on every read:

| Operation | Cross-contract calls | Storage work |
|-----------|----------------------|--------------|
| `submit` | 2 (`escrow.get`, already needed to verify the job, plus the token's `decimals()`; the latter is skipped for a zero amount) | O(1): the raw `Rating`, one `(ratee, rater, escrow_id)` marker, one `Aggregate` |
| `get_aggregate` | 0 | O(1): a single `Aggregate` read |
| `get_rating` | 0 | O(1) |

Nothing here scales with the number of ratings an address has received, so a
popular freelancer cannot become unreadable — or unratable — as their history
grows. That matters because the profile page polls `get_aggregate`.

`submit` is also what records "this rating has counted": the presence of the
`(ratee, rater, escrow_id)` marker is the per-escrow anti-spam check, so no
growing per-ratee list is deserialized or rewritten.

## Why this rule

- **Amount weighting** makes a high rating on a meaningful job worth more than a
  high rating on a trivial one, without changing the raw data.
- **One rating per (rater, escrow)** keeps each job to a single vote, and a
  rating needs a funded, completed escrow. Splitting work into many tiny
  escrows buys many votes, but each carries only its own tiny weight, so it
  cannot outweigh a genuinely large job (see the residual risk below).

## Storage layout (upgrade note)

The aggregate lives under `DataKey::Aggregate(address)`, and the anti-spam
marker under `DataKey::RatingCounted(ratee, rater, escrow_id)`. Both replace the previous
`DataKey::RateeRaters(address)` list, which held an entry for *every* rating and
was deserialized and rewritten in full on each `submit` — the unbounded cost
this change removes.

Consequences:

- **Redeploy required.** A contract instance whose ratings predate this change
  has no stored aggregates, and the old list is no longer read, so
  `get_aggregate` returns zeros for those addresses. Deploy the new wasm with
  `scripts/deploy_testnet.sh`; contract ids change and `frontend/.env` is
  regenerated, as with any deploy.
- **Changing the rule later needs a rebuild.** Because the aggregate is now
  computed once and stored, a different weighting rule (recency decay, per-pair
  amount caps) needs existing aggregates recomputed rather than a small change
  to `get_aggregate`. `get_rating(rater, escrow_id)` and the `rated` event
  (see [`EVENTS.md`](./EVENTS.md), which carries `rater`, `ratee` and `score`)
  are the raw, rule-free records to rebuild from — the event is the
  enumerable one, since ratings themselves are keyed by `(rater, escrow_id)`.

## Residual sybil risk (not solved)

- A colluding pair can rate each other on as many escrows as they care to fund,
  and can choose the size of each to maximise its weight. Each rating still
  costs a real, completed escrow, and its influence is capped by that escrow's
  amount.
- The rule assumes escrow `total_amount` is real value; on testnet it is not.
- There is no decay by recency and no per-pair amount cap. These are deliberate
  omissions to keep the rule small and explainable, and are candidates for a
  follow-up.

This is a mitigation, not a guarantee.
