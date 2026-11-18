import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { MessageRole, SemanticMemoryCategory } from "../src/generated/prisma/enums.js";
import { EpisodicMemory, type ConversationScope } from "../src/episodic-memory.js";
import { createPostgresClient } from "../src/postgres-client.js";
import { SemanticFactReviewService } from "../src/semantic-memory-review.js";
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
  const tenant = await prisma.tenant.create({ data: { name: "Semantic fact review test" } });
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

describe("SemanticFactReviewService", () => {
  it("persists only candidates the reviewer approves", async () => {
    const owner = await createOwner();
    const messages: ExtractionMessage[] = [
      { id: owner.sourceMessageId, role: "user", content: "Use Redis directly for working memory." },
    ];
    const candidates: SemanticFactCandidate[] = [
      {
        content: "The user wants to use Redis for working memory.",
        category: SemanticMemoryCategory.preference,
        sourceMessageId: owner.sourceMessageId,
      },
      {
        content: "The user has already implemented Map-based memory many times.",
        category: SemanticMemoryCategory.profile,
        sourceMessageId: owner.sourceMessageId,
      },
    ];
    const service = new SemanticFactReviewService(
      { extract: async () => candidates },
      semanticMemory,
    );

    try {
      const result = await service.extractReviewAndSave(
        owner.scope,
        owner.conversationId,
        messages,
        async (_candidate, index) => index === 0,
      );

      assert.equal(result.reviewed.length, 2);
      assert.deepEqual(result.reviewed.map((item) => item.approved), [true, false]);
      assert.equal(result.saved.length, 1);
      assert.equal(result.saved[0]?.content, "The user wants to use Redis for working memory.");
      assert.equal(result.saved[0]?.sourceMessage.id, owner.sourceMessageId);
      assert.equal(await prisma.semanticMemory.count({ where: { tenantId: owner.tenantId } }), 1);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("does not write anything when all candidates are declined", async () => {
    const owner = await createOwner();
    const candidate: SemanticFactCandidate = {
      content: "The user wants to use Redis for working memory.",
      category: SemanticMemoryCategory.preference,
      sourceMessageId: owner.sourceMessageId,
    };
    const service = new SemanticFactReviewService(
      { extract: async () => [candidate] },
      semanticMemory,
    );

    try {
      const result = await service.extractReviewAndSave(
        owner.scope,
        owner.conversationId,
        [{ id: owner.sourceMessageId, role: "user", content: "Use Redis directly for working memory." }],
        async () => false,
      );

      assert.equal(result.reviewed[0]?.approved, false);
      assert.deepEqual(result.saved, []);
      assert.equal(await prisma.semanticMemory.count({ where: { tenantId: owner.tenantId } }), 0);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });
});
