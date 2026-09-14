-- Supervisor dispatch workflow: stage/state, the documents each stage captures,
-- and line-level rate. Every change is additive or a widening (NOT NULL -> NULL),
-- so no existing row changes meaning and no existing query stops working.

-- Where a dispatch has got to, and what it is doing.
CREATE TYPE "DispatchStage" AS ENUM ('FLEET', 'MATERIALS', 'PROOF');
CREATE TYPE "DispatchState" AS ENUM ('ACTIVE', 'IN_TRANSIT', 'COMPLETED');

-- Defaults are deliberately the FINISHED values: every dispatch that already
-- exists was written by the allocation flow in a single request, which means it
-- was created and completed at once. Backfilling them as ACTIVE would put years
-- of finished history into the Supervisor's "still to do" list.
ALTER TABLE "OutwardLoad"
  ADD COLUMN "driverPhone"    TEXT,
  ADD COLUMN "stage"          "DispatchStage" NOT NULL DEFAULT 'PROOF',
  ADD COLUMN "state"          "DispatchState" NOT NULL DEFAULT 'COMPLETED',
  ADD COLUMN "emptySlipUrl"   TEXT,
  ADD COLUMN "filledImageUrl" TEXT,
  ADD COLUMN "dcUrl"          TEXT,
  ADD COLUMN "dispatchedAt"   TIMESTAMP(3),
  ADD COLUMN "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "OutwardLoad_yardId_state_createdAt_idx"
  ON "OutwardLoad"("yardId", "state", "createdAt");

-- The Supervisor flow loads a vehicle directly, with no buyer allocation behind
-- it, so a line may have no sale. Existing lines all keep theirs.
ALTER TABLE "OutwardLoadLine"
  ALTER COLUMN "saleId" DROP NOT NULL,
  ADD COLUMN "ratePerKg"     DOUBLE PRECISION,
  ADD COLUMN "materialLabel" TEXT;
