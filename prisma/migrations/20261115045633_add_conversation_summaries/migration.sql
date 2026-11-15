-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "nextSummaryVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "summaryThroughSequenceNo" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ConversationSummary" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "summaryText" TEXT NOT NULL,
    "throughSequenceNo" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationSummary_tenantId_conversationId_throughSequence_idx" ON "ConversationSummary"("tenantId", "conversationId", "throughSequenceNo");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationSummary_tenantId_conversationId_version_key" ON "ConversationSummary"("tenantId", "conversationId", "version");

-- AddForeignKey
ALTER TABLE "ConversationSummary" ADD CONSTRAINT "ConversationSummary_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
