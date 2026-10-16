-- Amount released so far on a milestone (issue #25).
--
-- `escrow.release_partial` pays a milestone down over several transactions, each
-- emitting the same `milestone_released` event as a full release. Without a
-- running total the indexer could not tell a partial payment from a complete
-- one, so it recorded every event as RELEASED and completed the job while the
-- freelancer was still owed the remainder.
ALTER TABLE "Milestone" ADD COLUMN "releasedAmount" DECIMAL(65,30) NOT NULL DEFAULT 0;
