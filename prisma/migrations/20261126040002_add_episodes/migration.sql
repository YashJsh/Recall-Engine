-- CreateEnum
CREATE TYPE "EpisodeType" AS ENUM ('event', 'conversation');

-- CreateTable
CREATE TABLE "Episode" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "EpisodeType" NOT NULL,
    "content" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6),
    "endedAt" TIMESTAMPTZ(6),
    "sourceConversationId" UUID NOT NULL,
    "sourceMessageId" UUID,
    "throughSequenceNo" INTEGER,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Episode_tenantId_userId_createdAt_idx" ON "Episode"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_tenantId_sourceConversationId_type_dedupeKey_key" ON "Episode"("tenantId", "sourceConversationId", "type", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_tenantId_userId_sourceConversationId_fkey" FOREIGN KEY ("tenantId", "userId", "sourceConversationId") REFERENCES "Conversation"("tenantId", "userId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_tenantId_sourceConversationId_sourceMessageId_fkey" FOREIGN KEY ("tenantId", "sourceConversationId", "sourceMessageId") REFERENCES "ConversationMessage"("tenantId", "conversationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
