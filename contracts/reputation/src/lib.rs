//! Reputation Contract
//!
//! Records on-chain ratings after each completed job.
//! Ratings are immutable once submitted and keyed by `(rater, escrow_id)` to
//! prevent duplicates.
//!
//! # Contributor Notes
//! - A rating is only accepted if the escrow contract reports the job as
//!   `Completed` and the rater/ratee are the two participants. This contract
//!   therefore depends on the `escrow` crate for its generated client.
//! - Raw ratings are stored unchanged and remain the source of truth. The
//!   **weighted** aggregate (see `docs/REPUTATION.md`) is *maintained* by
//!   `submit` rather than derived on read:
//!     * each counted rating is weighted by its escrow's `total_amount`
//!       **normalized to a fixed 7-decimal scale** using the escrow token's own
//!       `decimals()`, so 18-decimal tokens neither overflow `u64` nor outweigh
//!       7-decimal ones such as USDC 10^11 to 1,
//!     * every rating counts once, keyed by `(ratee, rater, escrow_id)`, so a
//!       rater can rate the same counterparty on any number of distinct escrows
//!       (a small first job does not mute later, larger ones),
//!     * `weight` is the sum of weights and `total_score` the weight-summed
//!       score, so `average = total_score / weight`.
//!
//! `submit` already reads the escrow to verify completion; weighting adds one
//! read-only `decimals()` call on the escrow's token. `get_aggregate` is a single
//! storage read with no cross-contract call (see the cost model in
//! `docs/REPUTATION.md`).
//! - Phase 3 (future work, not yet filed): skill-tag endorsements.

#![no_std]

use interface::{EscrowClient, EscrowData, EscrowStatus};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token::TokenClient,
    Address, Env,
};

// ---------------------------------------------------------------------------
// TTL constants
// ---------------------------------------------------------------------------

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 90 * DAY_IN_LEDGERS;

/// Decimal scale every rating weight is normalized to. 7 is the Stellar
/// standard (XLM and USDC), so a weight is "whole tokens × 10^7" regardless of
/// the token's own precision. In `u64` this tops out at ~1.8 × 10^12 whole
/// tokens per escrow, versus ~18 for a raw 18-decimal base-unit amount.
pub const WEIGHT_DECIMALS: u32 = 7;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub struct Rating {
    pub rater: Address,
    pub ratee: Address,
    pub escrow_id: u64,
    pub score: u32, // 1–5
    pub submitted_at: u64,
}

/// Weighted reputation for an address.
///
/// `average = total_score / weight` (0 when `weight` is 0). `count` is the
/// number of ratings that counted toward the aggregate. Maintained by `submit`,
/// so reading it is a single storage read.
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub struct Aggregate {
    pub total_score: u64,
    pub weight: u64,
    pub count: u64,
}

#[contracttype]
pub enum DataKey {
    /// Keyed by (rater, escrow_id) to prevent duplicate ratings.
    Rating(Address, u64),
    /// Keyed by (ratee, rater, escrow_id). Presence means this rater's rating
    /// for this escrow has been folded into the ratee's aggregate. Scoped by
    /// escrow so the same pair can be rated on every job they complete, while a
    /// single escrow still counts at most once. This replaces the old per-ratee
    /// list of every rating, which grew with each rating and was deserialized
    /// and rewritten in full on every submit.
    RatingCounted(Address, Address, u64),
    /// ratee → the maintained weighted aggregate.
    Aggregate(Address),
    Admin,
    EscrowContract,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rated {
    #[topic]
    pub escrow_id: u64,
    pub rater: Address,
    pub ratee: Address,
    pub score: u32,
    /// The ratee's weighted-aggregate count after this rating is recorded.
    pub count: u64,
    /// The ratee's weighted-aggregate total_score after this rating is recorded.
    pub total_score: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ReputationError {
    NotFound = 1,
    AlreadyInitialized = 2,
    NotInitialized = 3,
    InvalidScore = 4,
    AlreadyRated = 5,
    EscrowNotFound = 6,
    EscrowNotCompleted = 7,
    Unauthorized = 8,
    InvalidRatee = 9,
    Overflow = 10,
    /// The escrow's token did not answer `decimals()`, so its amount cannot be
    /// normalized into a weight.
    TokenDecimalsUnavailable = 11,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ReputationContract;

#[contractimpl]
impl ReputationContract {
    /// One-time initialisation: set the admin and the trusted escrow contract.
    pub fn init(env: Env, admin: Address, escrow_contract: Address) -> Result<(), ReputationError> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ReputationError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::EscrowContract, &escrow_contract);
        Self::extend_instance(&env);
        Ok(())
    }

    /// Change the trusted escrow contract. Admin only.
    pub fn set_escrow_contract(env: Env, escrow_contract: Address) -> Result<(), ReputationError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ReputationError::NotInitialized)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::EscrowContract, &escrow_contract);
        Self::extend_instance(&env);
        Ok(())
    }

    /// Submit a rating after a job completes.
    ///
    /// Verifies with the escrow contract that the job is completed and that the
    /// rater and ratee are its two participants, stores the raw rating as-is,
    /// and folds it into the ratee's aggregate (see [`get_aggregate`]), weighted
    /// by the escrow it is for. Each escrow counts once per rater.
    ///
    /// # Arguments
    /// - `rater`     – address submitting the rating (must be a participant)
    /// - `ratee`     – address being rated (must be the other participant)
    /// - `escrow_id` – completed escrow this rating is for
    /// - `score`     – 1 to 5
    pub fn submit(
        env: Env,
        rater: Address,
        ratee: Address,
        escrow_id: u64,
        score: u32,
    ) -> Result<(), ReputationError> {
        rater.require_auth();

        if !(1..=5).contains(&score) {
            return Err(ReputationError::InvalidScore);
        }

        let escrow_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::EscrowContract)
            .ok_or(ReputationError::NotInitialized)?;

        // `try_*` returns a nested Result: the outer for invocation/conversion
        // failures and the inner for the contract's own Result error.
        let escrow: EscrowData = EscrowClient::new(&env, &escrow_contract)
            .try_get(&escrow_id)
            .map_err(|_| ReputationError::EscrowNotFound)?
            .map_err(|_| ReputationError::EscrowNotFound)?;
        if escrow.status != EscrowStatus::Completed {
            return Err(ReputationError::EscrowNotCompleted);
        }

        // The rater must be one participant and the ratee the other.
        let expected_ratee = if rater == escrow.client {
            escrow.freelancer.clone()
        } else if rater == escrow.freelancer {
            escrow.client.clone()
        } else {
            return Err(ReputationError::Unauthorized);
        };
        if ratee != expected_ratee {
            return Err(ReputationError::InvalidRatee);
        }

        let key = DataKey::Rating(rater.clone(), escrow_id);
        if env.storage().persistent().has(&key) {
            return Err(ReputationError::AlreadyRated);
        }

        let rating = Rating {
            rater: rater.clone(),
            ratee: ratee.clone(),
            escrow_id,
            score,
            submitted_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &rating);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);

        // Fold the rating into the ratee's aggregate, at most once per
        // (ratee, rater, escrow): weighted by the job's `total_amount`, so a
        // rater's later, larger jobs are not discarded because of an earlier
        // small one. Duplicates on one escrow are already rejected above
        // (`AlreadyRated`), and repeat-farming costs a real, funded escrow per
        // rating, weighted by its amount. The escrow was
        // already read above to verify completion, so this costs no extra
        // cross-contract call and keeps `get_aggregate` a single storage read.
        let counted_key = DataKey::RatingCounted(ratee.clone(), rater.clone(), escrow_id);
        if !env.storage().persistent().has(&counted_key) {
            let weight = Self::normalized_weight(&env, &escrow.token, escrow.total_amount)?;
            if weight > 0 {
                env.storage().persistent().set(&counted_key, &escrow_id);
                env.storage()
                    .persistent()
                    .extend_ttl(&counted_key, TTL_THRESHOLD, TTL_EXTEND_TO);

                let mut aggregate = Self::get_aggregate(env.clone(), ratee.clone());
                aggregate.total_score = aggregate
                    .total_score
                    .saturating_add((score as u64).saturating_mul(weight));
                aggregate.weight = aggregate.weight.saturating_add(weight);
                aggregate.count = aggregate.count.saturating_add(1);

                let aggregate_key = DataKey::Aggregate(ratee.clone());
                env.storage().persistent().set(&aggregate_key, &aggregate);
                env.storage()
                    .persistent()
                    .extend_ttl(&aggregate_key, TTL_THRESHOLD, TTL_EXTEND_TO);
            }
        }

        Self::extend_instance(&env);

        let aggregate = Self::get_aggregate(env.clone(), ratee.clone());
        Rated {
            escrow_id,
            rater,
            ratee,
            score,
            count: aggregate.count,
            total_score: aggregate.total_score,
        }
        .publish(&env);
        Ok(())
    }

    /// Weighted reputation for `address`.
    ///
    /// Each counted rating was weighted by its escrow's `total_amount`,
    /// normalized to [`WEIGHT_DECIMALS`], when it was submitted; each escrow counts once per rater. Averaging is
    /// `total_score / weight`. Raw ratings are never
    /// modified.
    ///
    /// `submit` maintains the value, so this reads one storage entry and makes
    /// **no** cross-contract call, regardless of how many ratings exist. An
    /// address with no counted ratings returns the zero aggregate.
    pub fn get_aggregate(env: Env, address: Address) -> Aggregate {
        let key = DataKey::Aggregate(address);
        let stored: Option<Aggregate> = env.storage().persistent().get(&key);
        if stored.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
        stored.unwrap_or(Aggregate {
            total_score: 0,
            weight: 0,
            count: 0,
        })
    }

    /// Read a single rating (view).
    pub fn get_rating(env: Env, rater: Address, escrow_id: u64) -> Result<Rating, ReputationError> {
        env.storage()
            .persistent()
            .get(&DataKey::Rating(rater, escrow_id))
            .ok_or(ReputationError::NotFound)
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// An escrow amount as a rating weight: whole tokens scaled to
    /// [`WEIGHT_DECIMALS`] (7), independent of the token's own precision.
    ///
    /// Raw base units are not comparable across tokens (10 USDC is 10^8, ten
    /// 18-decimal tokens are 10^19) and overflow `u64` for 18-decimal jobs of
    /// ~18 tokens or more. Tokens with more than 7 decimals are divided down
    /// (sub-10^-7 dust truncates, and a job that truncates to zero weight is
    /// stored but not counted); tokens with fewer are scaled up. A non-positive
    /// amount weighs zero without touching the token.
    fn normalized_weight(env: &Env, token: &Address, amount: i128) -> Result<u64, ReputationError> {
        if amount <= 0 {
            return Ok(0);
        }
        let decimals = TokenClient::new(env, token)
            .try_decimals()
            .map_err(|_| ReputationError::TokenDecimalsUnavailable)?
            .map_err(|_| ReputationError::TokenDecimalsUnavailable)?;

        let normalized = if decimals > WEIGHT_DECIMALS {
            let divisor = 10i128
                .checked_pow(decimals - WEIGHT_DECIMALS)
                .ok_or(ReputationError::Overflow)?;
            amount / divisor
        } else {
            let multiplier = 10i128
                .checked_pow(WEIGHT_DECIMALS - decimals)
                .ok_or(ReputationError::Overflow)?;
            amount
                .checked_mul(multiplier)
                .ok_or(ReputationError::Overflow)?
        };
        normalized.try_into().map_err(|_| ReputationError::Overflow)
    }

    fn extend_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test;
