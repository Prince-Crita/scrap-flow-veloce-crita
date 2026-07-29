-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER', 'ADMIN');

-- CreateEnum
CREATE TYPE "LoadStatus" AS ENUM ('RECEIVED', 'SEGREGATED');

-- CreateEnum
CREATE TYPE "SegregationStatus" AS ENUM ('OPEN', 'COMPLETED');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('DRAFT', 'DISPATCHED');

-- CreateEnum
CREATE TYPE "ReceivableStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID');

-- CreateEnum
CREATE TYPE "TxnType" AS ENUM ('INWARD', 'SEGREGATION_IN', 'SEGREGATION_OUT', 'WASTAGE', 'SALE', 'OUTWARD', 'STOCK_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('PENDING', 'PARTIAL', 'COMPLETED');

-- CreateTable
CREATE TABLE "Yard" (
    "id" TEXT NOT NULL,
    "yardCode" TEXT NOT NULL,
    "yardName" TEXT NOT NULL,
    "ownerName" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT DEFAULT 'India',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "contactNumber" TEXT,
    "gstNumber" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Yard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MANAGER',
    "yardId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gstNumber" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Buyer" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gstNumber" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Buyer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sku" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT '📦',
    "materialId" TEXT,
    "saleThresholdKg" INTEGER NOT NULL DEFAULT 1000,
    "isMixedBucket" BOOLEAN NOT NULL DEFAULT false,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventory" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "quantityKg" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InwardLoad" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "lotNumber" TEXT NOT NULL,
    "vendorId" TEXT,
    "materialId" TEXT,
    "materialLabel" TEXT NOT NULL,
    "totalKg" INTEGER NOT NULL,
    "vehicleNumber" TEXT,
    "vehicleType" TEXT,
    "driverName" TEXT,
    "ocrConfidence" DOUBLE PRECISION,
    "frontImageUrl" TEXT,
    "backImageUrl" TEXT,
    "weighbridgeSlipUrl" TEXT,
    "status" "LoadStatus" NOT NULL DEFAULT 'RECEIVED',
    "capturedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InwardLoad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeightEntry" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "lineId" TEXT,
    "skuId" TEXT,
    "sequence" INTEGER NOT NULL,
    "kg" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeightEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InwardLoadLine" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "skuId" TEXT NOT NULL,
    "materialId" TEXT,
    "materialLabel" TEXT NOT NULL,
    "quantityKg" INTEGER NOT NULL,
    "status" "LoadStatus" NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InwardLoadLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialImage" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegregationRun" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "sourceLoadId" TEXT,
    "sourceSkuId" TEXT NOT NULL,
    "totalKg" INTEGER NOT NULL,
    "wastageKg" INTEGER NOT NULL DEFAULT 0,
    "wastagePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "SegregationStatus" NOT NULL DEFAULT 'COMPLETED',
    "completedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SegregationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegregationAllocation" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "kg" INTEGER NOT NULL,

    CONSTRAINT "SegregationAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "quantityKg" INTEGER NOT NULL,
    "ratePerKg" DOUBLE PRECISION NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "gstRate" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "gstAmount" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "vehicleNumber" TEXT,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "status" "SaleStatus" NOT NULL DEFAULT 'DISPATCHED',
    "dispatchedKg" INTEGER,
    "dispatchStatus" "DispatchStatus",
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receivable" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "ReceivableStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receivable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryTransaction" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "changeKg" INTEGER NOT NULL,
    "type" "TxnType" NOT NULL,
    "refId" TEXT,
    "refType" TEXT,
    "byUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLot" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "vendorId" TEXT,
    "vehicleNumber" TEXT,
    "sourceLoadId" TEXT,
    "originalKg" INTEGER NOT NULL,
    "remainingKg" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Counter" (
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "yardId" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImpersonationSession" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "endReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "ImpersonationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutwardLoad" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "dispatchNumber" TEXT NOT NULL,
    "vehicleNumber" TEXT,
    "vehicleType" TEXT,
    "driverName" TEXT,
    "ocrConfidence" DOUBLE PRECISION,
    "frontImageUrl" TEXT,
    "backImageUrl" TEXT,
    "totalKg" INTEGER NOT NULL,
    "dispatchedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutwardLoad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutwardLoadLine" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "quantityKg" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutwardLoadLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutwardImage" (
    "id" TEXT NOT NULL,
    "yardId" TEXT NOT NULL,
    "loadId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutwardImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Yard_yardCode_key" ON "Yard"("yardCode");

-- CreateIndex
CREATE INDEX "Yard_active_idx" ON "Yard"("active");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_yardId_idx" ON "User"("yardId");

-- CreateIndex
CREATE INDEX "Vendor_name_idx" ON "Vendor"("name");

-- CreateIndex
CREATE INDEX "Vendor_yardId_active_idx" ON "Vendor"("yardId", "active");

-- CreateIndex
CREATE INDEX "Buyer_name_idx" ON "Buyer"("name");

-- CreateIndex
CREATE INDEX "Buyer_yardId_idx" ON "Buyer"("yardId");

-- CreateIndex
CREATE INDEX "Material_yardId_active_idx" ON "Material"("yardId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Material_yardId_name_key" ON "Material"("yardId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Material_yardId_code_key" ON "Material"("yardId", "code");

-- CreateIndex
CREATE INDEX "Sku_yardId_sortOrder_idx" ON "Sku"("yardId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_yardId_name_key" ON "Sku"("yardId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_yardId_code_key" ON "Sku"("yardId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Inventory_skuId_key" ON "Inventory"("skuId");

-- CreateIndex
CREATE INDEX "Inventory_yardId_idx" ON "Inventory"("yardId");

-- CreateIndex
CREATE INDEX "InwardLoad_yardId_status_idx" ON "InwardLoad"("yardId", "status");

-- CreateIndex
CREATE INDEX "InwardLoad_yardId_createdAt_idx" ON "InwardLoad"("yardId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InwardLoad_yardId_lotNumber_key" ON "InwardLoad"("yardId", "lotNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InwardLoad_yardId_clientRequestId_key" ON "InwardLoad"("yardId", "clientRequestId");

-- CreateIndex
CREATE INDEX "WeightEntry_loadId_idx" ON "WeightEntry"("loadId");

-- CreateIndex
CREATE INDEX "WeightEntry_lineId_idx" ON "WeightEntry"("lineId");

-- CreateIndex
CREATE INDEX "WeightEntry_yardId_idx" ON "WeightEntry"("yardId");

-- CreateIndex
CREATE INDEX "InwardLoadLine_loadId_idx" ON "InwardLoadLine"("loadId");

-- CreateIndex
CREATE INDEX "InwardLoadLine_yardId_status_idx" ON "InwardLoadLine"("yardId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InwardLoadLine_loadId_skuId_key" ON "InwardLoadLine"("loadId", "skuId");

-- CreateIndex
CREATE INDEX "MaterialImage_loadId_idx" ON "MaterialImage"("loadId");

-- CreateIndex
CREATE INDEX "MaterialImage_yardId_idx" ON "MaterialImage"("yardId");

-- CreateIndex
CREATE INDEX "SegregationRun_yardId_status_idx" ON "SegregationRun"("yardId", "status");

-- CreateIndex
CREATE INDEX "SegregationAllocation_runId_idx" ON "SegregationAllocation"("runId");

-- CreateIndex
CREATE INDEX "SegregationAllocation_yardId_idx" ON "SegregationAllocation"("yardId");

-- CreateIndex
CREATE INDEX "Sale_yardId_createdAt_idx" ON "Sale"("yardId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_yardId_invoiceNumber_key" ON "Sale"("yardId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_yardId_clientRequestId_key" ON "Sale"("yardId", "clientRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Receivable_saleId_key" ON "Receivable"("saleId");

-- CreateIndex
CREATE INDEX "Receivable_yardId_status_idx" ON "Receivable"("yardId", "status");

-- CreateIndex
CREATE INDEX "InventoryTransaction_type_idx" ON "InventoryTransaction"("type");

-- CreateIndex
CREATE INDEX "InventoryTransaction_yardId_skuId_idx" ON "InventoryTransaction"("yardId", "skuId");

-- CreateIndex
CREATE INDEX "InventoryTransaction_yardId_createdAt_idx" ON "InventoryTransaction"("yardId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryLot_vendorId_idx" ON "InventoryLot"("vendorId");

-- CreateIndex
CREATE INDEX "InventoryLot_sourceLoadId_idx" ON "InventoryLot"("sourceLoadId");

-- CreateIndex
CREATE INDEX "InventoryLot_yardId_skuId_idx" ON "InventoryLot"("yardId", "skuId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_yardId_createdAt_idx" ON "AuditLog"("yardId", "createdAt");

-- CreateIndex
CREATE INDEX "ImpersonationSession_adminId_startedAt_idx" ON "ImpersonationSession"("adminId", "startedAt");

-- CreateIndex
CREATE INDEX "ImpersonationSession_yardId_startedAt_idx" ON "ImpersonationSession"("yardId", "startedAt");

-- CreateIndex
CREATE INDEX "ImpersonationSession_endedAt_idx" ON "ImpersonationSession"("endedAt");

-- CreateIndex
CREATE INDEX "OutwardLoad_yardId_createdAt_idx" ON "OutwardLoad"("yardId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutwardLoad_yardId_dispatchNumber_key" ON "OutwardLoad"("yardId", "dispatchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OutwardLoad_yardId_clientRequestId_key" ON "OutwardLoad"("yardId", "clientRequestId");

-- CreateIndex
CREATE INDEX "OutwardLoadLine_loadId_idx" ON "OutwardLoadLine"("loadId");

-- CreateIndex
CREATE INDEX "OutwardLoadLine_saleId_idx" ON "OutwardLoadLine"("saleId");

-- CreateIndex
CREATE INDEX "OutwardLoadLine_yardId_skuId_idx" ON "OutwardLoadLine"("yardId", "skuId");

-- CreateIndex
CREATE INDEX "OutwardImage_loadId_idx" ON "OutwardImage"("loadId");

-- CreateIndex
CREATE INDEX "OutwardImage_yardId_idx" ON "OutwardImage"("yardId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Buyer" ADD CONSTRAINT "Buyer_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InwardLoad" ADD CONSTRAINT "InwardLoad_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InwardLoad" ADD CONSTRAINT "InwardLoad_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InwardLoad" ADD CONSTRAINT "InwardLoad_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InwardLoad" ADD CONSTRAINT "InwardLoad_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeightEntry" ADD CONSTRAINT "WeightEntry_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeightEntry" ADD CONSTRAINT "WeightEntry_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "InwardLoad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeightEntry" ADD CONSTRAINT "WeightEntry_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "InwardLoadLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeightEntry" ADD CONSTRAINT "WeightEntry_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InwardLoadLine" ADD CONSTRAINT "InwardLoadLine_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InwardLoadLine" ADD CONSTRAINT "InwardLoadLine_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "InwardLoad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InwardLoadLine" ADD CONSTRAINT "InwardLoadLine_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InwardLoadLine" ADD CONSTRAINT "InwardLoadLine_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialImage" ADD CONSTRAINT "MaterialImage_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialImage" ADD CONSTRAINT "MaterialImage_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "InwardLoad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegregationRun" ADD CONSTRAINT "SegregationRun_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegregationRun" ADD CONSTRAINT "SegregationRun_sourceLoadId_fkey" FOREIGN KEY ("sourceLoadId") REFERENCES "InwardLoad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegregationRun" ADD CONSTRAINT "SegregationRun_sourceSkuId_fkey" FOREIGN KEY ("sourceSkuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegregationRun" ADD CONSTRAINT "SegregationRun_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegregationAllocation" ADD CONSTRAINT "SegregationAllocation_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegregationAllocation" ADD CONSTRAINT "SegregationAllocation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SegregationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegregationAllocation" ADD CONSTRAINT "SegregationAllocation_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_sourceLoadId_fkey" FOREIGN KEY ("sourceLoadId") REFERENCES "InwardLoad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpersonationSession" ADD CONSTRAINT "ImpersonationSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpersonationSession" ADD CONSTRAINT "ImpersonationSession_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutwardLoad" ADD CONSTRAINT "OutwardLoad_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutwardLoad" ADD CONSTRAINT "OutwardLoad_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutwardLoadLine" ADD CONSTRAINT "OutwardLoadLine_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutwardLoadLine" ADD CONSTRAINT "OutwardLoadLine_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "OutwardLoad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutwardLoadLine" ADD CONSTRAINT "OutwardLoadLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutwardLoadLine" ADD CONSTRAINT "OutwardLoadLine_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutwardImage" ADD CONSTRAINT "OutwardImage_yardId_fkey" FOREIGN KEY ("yardId") REFERENCES "Yard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutwardImage" ADD CONSTRAINT "OutwardImage_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "OutwardLoad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

