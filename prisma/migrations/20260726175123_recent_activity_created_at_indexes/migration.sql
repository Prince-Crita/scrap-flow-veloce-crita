-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "InventoryTransaction_createdAt_idx" ON "InventoryTransaction"("createdAt");

-- CreateIndex
CREATE INDEX "InwardLoad_createdAt_idx" ON "InwardLoad"("createdAt");

-- CreateIndex
CREATE INDEX "OutwardLoad_createdAt_idx" ON "OutwardLoad"("createdAt");

-- CreateIndex
CREATE INDEX "Sale_createdAt_idx" ON "Sale"("createdAt");
