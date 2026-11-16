-- CreateEnum
CREATE TYPE "SemanticMemoryCategory" AS ENUM ('preference', 'profile', 'project_fact');

-- CreateEnum
CREATE TYPE "SemanticMemoryStatus" AS ENUM ('active', 'superseded');

-- CreateTable
CREATE TABLE "SemanticMemory" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "category" "SemanticMemoryCategory" NOT NULL,
    "status" "SemanticMemoryStatus" NOT NULL DEFAULT 'active',
    "sourceConversationId" UUID NOT NULL,
    "sourceMessageId" UUID NOT NULL,
    "supersedesMemoryId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SemanticMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SemanticMemory_tenantId_userId_status_createdAt_idx" ON "SemanticMemory"("tenantId", "userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SemanticMemory_tenantId_sourceConversationId_sourceMessageI_idx" ON "SemanticMemory"("tenantId", "sourceConversationId", "sourceMessageId");

-- CreateIndex
CREATE INDEX "SemanticMemory_tenantId_userId_supersedesMemoryId_idx" ON "SemanticMemory"("tenantId", "userId", "supersedesMemoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_tenantId_userId_id_key" ON "Conversation"("tenantId", "userId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationMessage_tenantId_conversationId_id_key" ON "ConversationMessage"("tenantId", "conversationId", "id");

-- AddForeignKey
ALTER TABLE "SemanticMemory" ADD CONSTRAINT "SemanticMemory_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SemanticMemory" ADD CONSTRAINT "SemanticMemory_tenantId_userId_sourceConversationId_fkey" FOREIGN KEY ("tenantId", "userId", "sourceConversationId") REFERENCES "Conversation"("tenantId", "userId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SemanticMemory" ADD CONSTRAINT "SemanticMemory_tenantId_sourceConversationId_sourceMessage_fkey" FOREIGN KEY ("tenantId", "sourceConversationId", "sourceMessageId") REFERENCES "ConversationMessage"("tenantId", "conversationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
