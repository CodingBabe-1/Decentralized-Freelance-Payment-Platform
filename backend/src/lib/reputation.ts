/**
 * reputation.ts
 *
 * The off-chain mirror of `reputation.get_aggregate` (issue #34).
 *
 * The contract maintains a **weighted** aggregate, not a plain mean: each
 * counted rating is weighted by its escrow's `total_amount` normalized to 7
 * decimals (`WEIGHT_DECIMALS`), and each escrow
 * counts once per rater (the `RatingCounted(ratee, rater, escrow_id)` marker),
 * so every `Rating` row counts. See
 * `docs/REPUTATION.md` and `contracts/reputation/src/lib.rs`.
 *
 * `GET /api/reputation/:address` has to answer with the same numbers, or the
 * API and the Profile page — which reads the chain directly — disagree for the
 * same address. This module is that arithmetic, kept free of Prisma and HTTP so
 * it can be unit-tested against the contract's rule.
 */

import { toBaseUnits } from "./assets";

/**
 * Decimal scale every rating weight is normalized to; mirrors `WEIGHT_DECIMALS`
 * in `contracts/reputation/src/lib.rs`. A weight is whole tokens × 10^7
 * whatever the token's own precision, so 7-decimal assets (USDC, XLM) and
 * 18-decimal ones weigh the same for the same whole amount.
 */
export const WEIGHT_DECIMALS = 7;

/** The fields of a rating this calculation needs. */
export interface WeightedRating {
  score: number;
  job: {
    /** `Job.totalAmount`, a Prisma Decimal in whole units of `asset`. */
    totalAmount: { toString(): string } | string | number;
  };
}

/** `Aggregate` as the reputation contract stores and returns it. */
export interface WeightedAggregate {
  /** sum(score × weight) — `Aggregate.total_score` on chain. */
  totalScore: bigint;
  /** sum(weight) — `Aggregate.weight` on chain, the escrow totals. */
  weight: bigint;
  /** Number of ratings that counted — `Aggregate.count` on chain. */
  count: number;
}

/**
 * The weight of one rating: its job's whole-unit amount scaled to
 * `WEIGHT_DECIMALS`, truncating anything finer. This equals the contract's
 * `normalized_weight` (token base units divided or multiplied by the distance
 * from 7 decimals) without needing the asset's own decimals. A zero or
 * unparseable amount weighs zero — the rating is stored but does not move the
 * aggregate, like a zero-amount escrow on chain.
 */
function ratingWeight(rating: WeightedRating): bigint {
  try {
    return toBaseUnits(rating.job.totalAmount.toString(), WEIGHT_DECIMALS);
  } catch {
    return 0n;
  }
}

/**
 * Fold raw ratings into the contract's weighted aggregate.
 *
 * `Rating` rows are unique per `(rater, job)`, the same granularity as the
 * contract's `(ratee, rater, escrow_id)` marker, so no extra de-duplication is
 * needed: every row counts, except a zero-weight one, which the contract stores
 * but does not fold in. The count is the number of counted ratings, not rows.
 */
export function computeWeightedAggregate(
  ratings: readonly WeightedRating[],
): WeightedAggregate {
  let totalScore = 0n;
  let weight = 0n;
  let count = 0;

  for (const rating of ratings) {
    const ratingWeightBaseUnits = ratingWeight(rating);
    if (ratingWeightBaseUnits <= 0n) continue;

    totalScore += BigInt(rating.score) * ratingWeightBaseUnits;
    weight += ratingWeightBaseUnits;
    count += 1;
  }

  return { totalScore, weight, count };
}
