-- Dispatch workflow: In Transit becomes a real stage, and Proof of Dispatch
-- becomes its own step (loaded weighbridge slip + who signed it off).
--
-- Entirely additive. No column is dropped, no value is rewritten, and no
-- existing row changes meaning:
--   • every dispatch already finished keeps state = 'COMPLETED', which stays
--     the authority for "this is done" — the new columns read as NULL and are
--     never back-filled or re-evaluated;
--   • 'TRANSIT' is appended to the enum, so no stored value is invalidated.

-- Postgres cannot add an enum value and use it in the same transaction, and
-- Prisma wraps a migration in one. IF NOT EXISTS keeps this re-runnable.
ALTER TYPE "DispatchStage" ADD VALUE IF NOT EXISTS 'TRANSIT';

-- The loaded-vehicle weighbridge slip: the counterpart to "emptySlipUrl".
ALTER TABLE "OutwardLoad" ADD COLUMN IF NOT EXISTS "loadedSlipUrl" TEXT;

-- Who signed off the proof. Distinct from "dispatchedById" (who opened the
-- dispatch at Fleet): across a shift handover they are different people.
ALTER TABLE "OutwardLoad" ADD COLUMN IF NOT EXISTS "proofById" TEXT;

-- Invoice attached by the Owner from Ready to Invoice, after completion.
ALTER TABLE "OutwardLoad" ADD COLUMN IF NOT EXISTS "invoiceUrl" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OutwardLoad_proofById_fkey'
  ) THEN
    ALTER TABLE "OutwardLoad"
      ADD CONSTRAINT "OutwardLoad_proofById_fkey"
      FOREIGN KEY ("proofById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
