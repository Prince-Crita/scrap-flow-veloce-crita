-- Dispatch paperwork captured with a sale allocation.
--
-- These four columns were added to the live database with `db push` while the
-- Sell sheet's document upload was built, so the schema and the database agreed
-- but the migration history did not. Recorded here so a database rebuilt purely
-- from migrations (a preview branch, a new environment) gets the same shape.
--
-- Additive only: every column is nullable or defaulted, so applying it to a
-- database that already has them is the only difference, and that case is
-- handled by marking this migration as already applied (`migrate resolve`).

ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "frontImageUrl" TEXT;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "backImageUrl" TEXT;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "weighbridgeSlipUrl" TEXT;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "documentUrls" TEXT[];
