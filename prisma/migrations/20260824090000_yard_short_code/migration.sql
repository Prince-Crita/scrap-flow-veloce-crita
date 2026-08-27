-- Short, spoken yard code — the leading segment of a load's business reference
-- ("TY1-0005").
--
-- Additive and nullable, so no existing row is rewritten. Codes are assigned by
-- prisma/backfill-yard-short-codes.ts for yards that already exist, and at yard
-- creation from then on. The unique index is what makes "short code + sequence"
-- unambiguous across yards.

-- AlterTable
ALTER TABLE "Yard" ADD COLUMN     "shortCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Yard_shortCode_key" ON "Yard"("shortCode");
