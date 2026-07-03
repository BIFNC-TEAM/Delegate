-- CreateEnum
CREATE TYPE "CreatorVerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "RepresentativeClaimStatus" AS ENUM ('CLAIMED', 'UNCLAIMED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "AmnWalletAccountType" AS ENUM ('USER_CASH', 'AGENT_TOKEN', 'CREATOR_PENDING', 'CREATOR_WITHDRAWABLE', 'PLATFORM_REVENUE', 'PROVIDER_COST');

-- CreateEnum
CREATE TYPE "AmnLedgerEntryKind" AS ENUM ('USER_RECHARGE', 'USER_CASH_DEBIT', 'AGENT_TOKEN_CREDIT', 'AGENT_TOKEN_DEBIT', 'CREATOR_PENDING_CREDIT', 'CREATOR_PENDING_DEBIT', 'CREATOR_WITHDRAWABLE_CREDIT', 'CREATOR_WITHDRAWABLE_DEBIT', 'PLATFORM_REVENUE_CREDIT', 'PROVIDER_COST_DEBIT', 'REFUND_REVERSAL', 'WITHDRAWAL_FREEZE', 'WITHDRAWAL_PAYOUT');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MOCK', 'STRIPE', 'WECHAT_PAY', 'ALIPAY', 'TELEGRAM_STARS');

-- CreateEnum
CREATE TYPE "RechargeOrderStatus" AS ENUM ('CREATED', 'REQUIRES_PAYMENT', 'PAID', 'FAILED', 'CANCELED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentProviderEventType" AS ENUM ('RECHARGE_PAID', 'RECHARGE_FAILED', 'REFUND_SUCCEEDED', 'CHARGEBACK_CREATED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AgentTokenPurchaseStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'REVERSED');

-- CreateEnum
CREATE TYPE "AgentUsageChargeKind" AS ENUM ('MODEL_TOKEN', 'COMPUTE_TIME', 'FIXED_TASK', 'BROWSER_TIME', 'MCP_CALL');

-- CreateEnum
CREATE TYPE "AgentUsageChargeStatus" AS ENUM ('CREATED', 'APPLIED', 'REVERSED');

-- CreateEnum
CREATE TYPE "CreatorEarningStatus" AS ENUM ('PENDING', 'WITHDRAWABLE', 'FROZEN', 'WITHDRAWN', 'REVERSED');

-- CreateEnum
CREATE TYPE "WithdrawRequestStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAID', 'FAILED', 'CANCELED');

-- AlterTable
ALTER TABLE "Owner" ADD COLUMN "creatorVerificationStatus" "CreatorVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED';

-- AlterTable
ALTER TABLE "Representative" ADD COLUMN "claimStatus" "RepresentativeClaimStatus" NOT NULL DEFAULT 'CLAIMED';

-- CreateTable
CREATE TABLE "UserWallet" (
    "id" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "telegramUserId" TEXT,
    "email" TEXT,
    "displayName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "cashBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentWallet" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "tokenBalance" INTEGER NOT NULL DEFAULT 0,
    "totalPurchasedTokens" INTEGER NOT NULL DEFAULT 0,
    "totalConsumedTokens" INTEGER NOT NULL DEFAULT 0,
    "tokenUnitPriceCents" INTEGER NOT NULL DEFAULT 1,
    "creatorRevenueShareBps" INTEGER NOT NULL DEFAULT 2000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletLedgerEntry" (
    "id" TEXT NOT NULL,
    "eventGroupId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "accountType" "AmnWalletAccountType" NOT NULL,
    "entryKind" "AmnLedgerEntryKind" NOT NULL,
    "userWalletId" TEXT,
    "agentWalletId" TEXT,
    "representativeId" TEXT,
    "ownerId" TEXT,
    "creatorEarningId" TEXT,
    "rechargeOrderId" TEXT,
    "paymentProviderEventId" TEXT,
    "tokenPurchaseId" TEXT,
    "usageChargeId" TEXT,
    "withdrawRequestId" TEXT,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "tokenAmount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "balanceAfterCents" INTEGER,
    "tokenBalanceAfter" INTEGER,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeOrder" (
    "id" TEXT NOT NULL,
    "userWalletId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'MOCK',
    "providerOrderId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "status" "RechargeOrderStatus" NOT NULL DEFAULT 'CREATED',
    "idempotencyKey" TEXT NOT NULL,
    "checkoutUrl" TEXT,
    "providerPayload" JSONB,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RechargeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" "PaymentProviderEventType" NOT NULL DEFAULT 'UNKNOWN',
    "rechargeOrderId" TEXT,
    "rawPayload" JSONB NOT NULL,
    "normalizedPayload" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    "idempotencyKey" TEXT,

    CONSTRAINT "PaymentProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTokenPurchase" (
    "id" TEXT NOT NULL,
    "userWalletId" TEXT NOT NULL,
    "agentWalletId" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "rechargeOrderId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "tokenAmount" INTEGER NOT NULL,
    "tokenUnitPriceCents" INTEGER NOT NULL,
    "creatorRevenueShareBps" INTEGER NOT NULL DEFAULT 2000,
    "creatorPendingCents" INTEGER NOT NULL,
    "status" "AgentTokenPurchaseStatus" NOT NULL DEFAULT 'COMPLETED',
    "idempotencyKey" TEXT NOT NULL,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTokenPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentUsageCharge" (
    "id" TEXT NOT NULL,
    "agentWalletId" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "tokenPurchaseId" TEXT,
    "kind" "AgentUsageChargeKind" NOT NULL,
    "status" "AgentUsageChargeStatus" NOT NULL DEFAULT 'CREATED',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "tokenAmount" INTEGER NOT NULL,
    "providerCostCents" INTEGER NOT NULL DEFAULT 0,
    "platformRevenueCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "AgentUsageCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorEarning" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "agentWalletId" TEXT NOT NULL,
    "tokenPurchaseId" TEXT,
    "usageChargeId" TEXT,
    "status" "CreatorEarningStatus" NOT NULL DEFAULT 'PENDING',
    "pendingCents" INTEGER NOT NULL DEFAULT 0,
    "withdrawableCents" INTEGER NOT NULL DEFAULT 0,
    "frozenCents" INTEGER NOT NULL DEFAULT 0,
    "withdrawnCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "revenueShareBps" INTEGER NOT NULL DEFAULT 2000,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorEarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawRequest" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "representativeId" TEXT,
    "status" "WithdrawRequestStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "provider" "PaymentProvider",
    "providerPayoutId" TEXT,
    "failureReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WithdrawRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserWallet_externalUserId_key" ON "UserWallet"("externalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "UserWallet_telegramUserId_key" ON "UserWallet"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "UserWallet_email_key" ON "UserWallet"("email");

-- CreateIndex
CREATE INDEX "UserWallet_currency_createdAt_idx" ON "UserWallet"("currency", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWallet_representativeId_key" ON "AgentWallet"("representativeId");

-- CreateIndex
CREATE INDEX "AgentWallet_currency_updatedAt_idx" ON "AgentWallet"("currency", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletLedgerEntry_idempotencyKey_key" ON "WalletLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_eventGroupId_createdAt_idx" ON "WalletLedgerEntry"("eventGroupId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_accountType_createdAt_idx" ON "WalletLedgerEntry"("accountType", "createdAt");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_entryKind_createdAt_idx" ON "WalletLedgerEntry"("entryKind", "createdAt");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_userWalletId_createdAt_idx" ON "WalletLedgerEntry"("userWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_agentWalletId_createdAt_idx" ON "WalletLedgerEntry"("agentWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_representativeId_createdAt_idx" ON "WalletLedgerEntry"("representativeId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_ownerId_createdAt_idx" ON "WalletLedgerEntry"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeOrder_providerOrderId_key" ON "RechargeOrder"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeOrder_idempotencyKey_key" ON "RechargeOrder"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RechargeOrder_userWalletId_status_createdAt_idx" ON "RechargeOrder"("userWalletId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "RechargeOrder_provider_status_createdAt_idx" ON "RechargeOrder"("provider", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderEvent_idempotencyKey_key" ON "PaymentProviderEvent"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderEvent_provider_providerEventId_key" ON "PaymentProviderEvent"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "PaymentProviderEvent_provider_eventType_receivedAt_idx" ON "PaymentProviderEvent"("provider", "eventType", "receivedAt");

-- CreateIndex
CREATE INDEX "PaymentProviderEvent_rechargeOrderId_receivedAt_idx" ON "PaymentProviderEvent"("rechargeOrderId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTokenPurchase_idempotencyKey_key" ON "AgentTokenPurchase"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentTokenPurchase_userWalletId_createdAt_idx" ON "AgentTokenPurchase"("userWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTokenPurchase_agentWalletId_createdAt_idx" ON "AgentTokenPurchase"("agentWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTokenPurchase_representativeId_status_createdAt_idx" ON "AgentTokenPurchase"("representativeId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentUsageCharge_idempotencyKey_key" ON "AgentUsageCharge"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentUsageCharge_agentWalletId_status_createdAt_idx" ON "AgentUsageCharge"("agentWalletId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentUsageCharge_representativeId_kind_createdAt_idx" ON "AgentUsageCharge"("representativeId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorEarning_idempotencyKey_key" ON "CreatorEarning"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreatorEarning_ownerId_status_createdAt_idx" ON "CreatorEarning"("ownerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CreatorEarning_representativeId_status_createdAt_idx" ON "CreatorEarning"("representativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CreatorEarning_agentWalletId_status_createdAt_idx" ON "CreatorEarning"("agentWalletId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawRequest_providerPayoutId_key" ON "WithdrawRequest"("providerPayoutId");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawRequest_idempotencyKey_key" ON "WithdrawRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WithdrawRequest_ownerId_status_requestedAt_idx" ON "WithdrawRequest"("ownerId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "WithdrawRequest_representativeId_status_requestedAt_idx" ON "WithdrawRequest"("representativeId", "status", "requestedAt");

-- AddForeignKey
ALTER TABLE "AgentWallet" ADD CONSTRAINT "AgentWallet_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_userWalletId_fkey" FOREIGN KEY ("userWalletId") REFERENCES "UserWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_agentWalletId_fkey" FOREIGN KEY ("agentWalletId") REFERENCES "AgentWallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_creatorEarningId_fkey" FOREIGN KEY ("creatorEarningId") REFERENCES "CreatorEarning"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_rechargeOrderId_fkey" FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_paymentProviderEventId_fkey" FOREIGN KEY ("paymentProviderEventId") REFERENCES "PaymentProviderEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_tokenPurchaseId_fkey" FOREIGN KEY ("tokenPurchaseId") REFERENCES "AgentTokenPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_usageChargeId_fkey" FOREIGN KEY ("usageChargeId") REFERENCES "AgentUsageCharge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_withdrawRequestId_fkey" FOREIGN KEY ("withdrawRequestId") REFERENCES "WithdrawRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeOrder" ADD CONSTRAINT "RechargeOrder_userWalletId_fkey" FOREIGN KEY ("userWalletId") REFERENCES "UserWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProviderEvent" ADD CONSTRAINT "PaymentProviderEvent_rechargeOrderId_fkey" FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTokenPurchase" ADD CONSTRAINT "AgentTokenPurchase_userWalletId_fkey" FOREIGN KEY ("userWalletId") REFERENCES "UserWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTokenPurchase" ADD CONSTRAINT "AgentTokenPurchase_agentWalletId_fkey" FOREIGN KEY ("agentWalletId") REFERENCES "AgentWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTokenPurchase" ADD CONSTRAINT "AgentTokenPurchase_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTokenPurchase" ADD CONSTRAINT "AgentTokenPurchase_rechargeOrderId_fkey" FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentUsageCharge" ADD CONSTRAINT "AgentUsageCharge_agentWalletId_fkey" FOREIGN KEY ("agentWalletId") REFERENCES "AgentWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentUsageCharge" ADD CONSTRAINT "AgentUsageCharge_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentUsageCharge" ADD CONSTRAINT "AgentUsageCharge_tokenPurchaseId_fkey" FOREIGN KEY ("tokenPurchaseId") REFERENCES "AgentTokenPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorEarning" ADD CONSTRAINT "CreatorEarning_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorEarning" ADD CONSTRAINT "CreatorEarning_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorEarning" ADD CONSTRAINT "CreatorEarning_agentWalletId_fkey" FOREIGN KEY ("agentWalletId") REFERENCES "AgentWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorEarning" ADD CONSTRAINT "CreatorEarning_tokenPurchaseId_fkey" FOREIGN KEY ("tokenPurchaseId") REFERENCES "AgentTokenPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorEarning" ADD CONSTRAINT "CreatorEarning_usageChargeId_fkey" FOREIGN KEY ("usageChargeId") REFERENCES "AgentUsageCharge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawRequest" ADD CONSTRAINT "WithdrawRequest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawRequest" ADD CONSTRAINT "WithdrawRequest_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE SET NULL ON UPDATE CASCADE;
