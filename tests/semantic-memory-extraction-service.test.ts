import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { MessageRole, SemanticMemoryCategory } from "../src/generated/prisma/enums.js";
import { EpisodicMemory, type ConversationScope } from "../src/episodic-memory.js";
import { createPostgresClient } from "../src/postgres-client.js";
import { AutomaticSemanticMemoryService } from "../src/semantic-memory-extraction-service.js";
import { SemanticMemoryStore } from "../src/semantic-memory.js";
import type { ExtractionInput, ExtractionMessage, SemanticFactCandidate } from "../src/semantic-fact-extractor.js";

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
      kind: "fact",
      durability: 0.9,
      occurredAt: null,
      sourceMessageId: owner.sourceMessageId,
    };
    const service = new AutomaticSemanticMemoryService(
      { extract: async () => [
        fact,
        {
          content: "The user agrees to use Redis for working memory.",
          category: SemanticMemoryCategory.preference,
          kind: "fact",
          durability: 0.9,
          occurredAt: null,
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

  it("saves no facts when every candidate cites something other than the target user message", async () => {
    const owner = await createOwner();
    const messages: ExtractionMessage[] = [
      { id: "assistant-message", role: "assistant", content: "The user likes hiking." },
      { id: owner.sourceMessageId, role: "user", content: "Hello." },
    ];
    const service = new AutomaticSemanticMemoryService(
      { extract: async () => [{
        content: "The user likes hiking.",
        category: SemanticMemoryCategory.profile,
        kind: "fact",
        durability: 0.9,
        occurredAt: null,
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

  it("saves only durable facts and reports requests, events, tasks and low durability as skipped", async () => {
    const owner = await createOwner();
    const messages: ExtractionMessage[] = [
      { id: owner.sourceMessageId, role: "user", content: "Give me a fun fact today." },
    ];
    const candidate = (content: string, kind: SemanticFactCandidate["kind"], durability: number): SemanticFactCandidate => ({
      content,
      category: SemanticMemoryCategory.preference,
      kind,
      durability,
      occurredAt: null,
      sourceMessageId: owner.sourceMessageId,
    });
    const service = new AutomaticSemanticMemoryService(
      { extract: async () => [
        candidate("The user wants a fun fact today.", "request", 0.05),
        candidate("The user won a 15km marathon on 2026-11-24.", "event", 0.4),
        candidate("The user wants https://example.com remembered for the current task.", "task", 0.1),
        candidate("The user wants to eat pizza tonight.", "fact", 0.2),
        candidate("The user is vegetarian.", "fact", 0.95),
      ] },
      semanticMemory,
    );

    try {
      const result = await service.extractAndSave(owner.scope, owner.conversationId, messages);

      assert.deepEqual(result.saved.map(({ content }) => content), ["The user is vegetarian."]);
      assert.deepEqual(result.skipped.map(({ reason }) => reason), [
        "not_a_fact",
        "not_a_fact",
        "not_a_fact",
        "low_durability",
      ]);
      assert.equal(await prisma.semanticMemory.count({ where: { tenantId: owner.tenantId } }), 1);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("gives the extractor the newest user message as target, at most 4 earlier messages, and the current date", async () => {
    const owner = await createOwner();
    const messages: ExtractionMessage[] = Array.from({ length: 6 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "assistant" : "user",
      content: `Message ${index}`,
    }));
    messages.push({ id: owner.sourceMessageId, role: "user", content: "I'm vegetarian." });
    let received: ExtractionInput | undefined;
    const service = new AutomaticSemanticMemoryService(
      { extract: async (input) => { received = input; return []; } },
      semanticMemory,
      undefined,
      undefined,
      { now: () => new Date("2026-11-25T10:00:00Z") },
    );

    try {
      await service.extractAndSave(owner.scope, owner.conversationId, messages);

      assert.equal(received?.target.id, owner.sourceMessageId);
      assert.deepEqual(received?.context.map(({ id }) => id), ["message-2", "message-3", "message-4", "message-5"]);
      assert.equal(received?.currentDate?.toISOString(), "2026-11-25T10:00:00.000Z");
      await assert.rejects(
        service.extractAndSave(owner.scope, owner.conversationId, messages.slice(0, -1).concat({
          id: "assistant-last", role: "assistant", content: "Done.",
        })),
        /newest user message/,
      );
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("rejects a durability threshold outside 0–1", () => {
    assert.throws(
      () => new AutomaticSemanticMemoryService({ extract: async () => [] }, semanticMemory, undefined, undefined, {
        durabilityThreshold: 1.5,
      }),
      /between 0 and 1/,
    );
  });
});
