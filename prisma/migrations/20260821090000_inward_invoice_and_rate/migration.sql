-- Inward workflow: invoice / challan answer, and a purchase rate per weighment.
--
-- Purely additive and entirely nullable. Every existing row reads as "not
-- recorded", which is the truth about it: the invoice question was never asked
-- and no rate was ever entered. Nothing is back-filled and no reader changes
-- meaning for historical data.

-- AlterTable
ALTER TABLE "InwardLoad" ADD COLUMN     "hasInvoice" BOOLEAN,
ADD COLUMN     "invoiceNumber" TEXT,
ADD COLUMN     "invoiceUrl" TEXT;

-- AlterTable
ALTER TABLE "WeightEntry" ADD COLUMN     "ratePerKg" DOUBLE PRECISION;
