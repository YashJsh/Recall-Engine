import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { MessageRole, SemanticMemoryCategory } from "../src/generated/prisma/enums.js";
import { EpisodicMemory, type ConversationScope } from "../src/episodic-memory.js";
import { createPostgresClient } from "../src/postgres-client.js";
import { AutomaticSemanticMemoryService } from "../src/semantic-memory-extraction-service.js";
import { SemanticMemoryStore } from "../src/semantic-memory.js";
import type { ExtractionMessage, SemanticFactCandidate } from "../src/semantic-fact-extractor.js";

const prisma = createPostgresClient();
const episodicMemory = new EpisodicMemory(prisma);
const semanticMemory = new SemanticMemoryStore(prisma);

interface TestOwner {
  tenantId: string;
  scope: ConversationScope;
  conversationId: string;
  sourceMessageId: string;
}

async function createOwner(): Promise<TestOwner> {
  const tenant = await prisma.tenant.create({ data: { name: "Automatic semantic memory test" } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, externalId: randomUUID() } });
  const session = await prisma.session.create({
    data: { tenantId: tenant.id, userId: user.id, externalId: randomUUID() },
  });
  const scope = { tenantId: tenant.id, userId: user.id, sessionId: session.id };
  const conversation = await episodicMemory.createConversation(scope);
  const source = await episodicMemory.appendMessage(scope, conversation.id, {
    role: MessageRole.user,
    content: "Use Redis directly for working memory.",
  });
  return { tenantId: tenant.id, scope, conversationId: conversation.id, sourceMessageId: source.id };
}

before(async () => { await prisma.$connect(); });
after(async () => { await prisma.$disconnect(); });

describe("AutomaticSemanticMemoryService", () => {
  it("automatically saves valid facts and skips vague confirmations and batch duplicates", async () => {
    const owner = await createOwner();
    const messages: ExtractionMessage[] = [
      { id: owner.sourceMessageId, role: "user", content: "Use Redis directly for working memory." },
    ];
    const fact: SemanticFactCandidate = {
      content: "The user wants to use Redis directly for working memory.",
      category: SemanticMemoryCategory.preference,
      sourceMessageId: owner.sourceMessageId,
    };
    const service = new AutomaticSemanticMemoryService(
      { extract: async () => [
        fact,
        {
          content: "The user agrees to use Redis for working memory.",
          category: SemanticMemoryCategory.preference,
          sourceMessageId: owner.sourceMessageId,
        },
        { ...fact, content: "  THE USER WANTS TO USE REDIS DIRECTLY FOR WORKING MEMORY.  " },
      ] },
      semanticMemory,
    );

    try {
      const result = await service.extractAndSave(owner.scope, owner.conversationId, messages);

      assert.equal(result.extracted.length, 3);
      assert.equal(result.saved.length, 1);
      assert.equal(result.saved[0]?.content, fact.content);
      assert.equal(result.saved[0]?.sourceMessage.id, owner.sourceMessageId);
      assert.deepEqual(result.skipped.map(({ reason }) => reason), [
        "confirmation_only",
        "duplicate_in_batch",
      ]);
      assert.equal(await prisma.semanticMemory.count({ where: { tenantId: owner.tenantId } }), 1);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("saves no facts when every candidate is unsupported by user messages", async () => {
    const owner = await createOwner();
    const messages: ExtractionMessage[] = [
      { id: owner.sourceMessageId, role: "user", content: "Hello." },
      { id: "assistant-message", role: "assistant", content: "The user likes hiking." },
    ];
    const service = new AutomaticSemanticMemoryService(
      { extract: async () => [{
        content: "The user likes hiking.",
        category: SemanticMemoryCategory.profile,
        sourceMessageId: "assistant-message",
      }] },
      semanticMemory,
    );

    try {
      const result = await service.extractAndSave(owner.scope, owner.conversationId, messages);

      assert.deepEqual(result.saved, []);
      assert.equal(result.skipped[0]?.reason, "unsupported_source");
      assert.equal(await prisma.semanticMemory.count({ where: { tenantId: owner.tenantId } }), 0);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });
});
