-- Driver's contact number on an inward load, captured in Vehicle Details next
-- to the driver's name.
--
-- Mirrors the existing Sale.driverPhone column. Additive and nullable, so no
-- existing row is rewritten: every load saved before this reads as "not
-- captured", which is exactly what it is.

-- AlterTable
ALTER TABLE "InwardLoad" ADD COLUMN     "driverPhone" TEXT;
