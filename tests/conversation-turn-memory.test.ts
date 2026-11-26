import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { AutomaticSemanticMemoryService } from "../src/semantic-memory-extraction-service.js";
import { SemanticMemoryCategory, SemanticMemoryStatus, MessageRole } from "../src/generated/prisma/enums.js";
import { ConversationPromptBuilder } from "../src/conversation-prompt-builder.js";
import {
  ConversationTurnMemoryService,
  ConversationTurnOrderError,
  PreparedConversationTurnError,
} from "../src/conversation-turn-memory.js";
import { ConversationContextCompactor, type ContextTokenCounter } from "../src/context-compaction.js";
import { EpisodicMemory, type ConversationScope } from "../src/episodic-memory.js";
import { createPostgresClient } from "../src/postgres-client.js";
import type { ExtractionInput, SemanticFactCandidate } from "../src/semantic-fact-extractor.js";
import {
  SemanticMemoryRetrievalService,
  type RetrievedSemanticMemory,
} from "../src/semantic-memory-retrieval.js";
import { SemanticMemoryStore } from "../src/semantic-memory.js";
import { ConversationSummaryService } from "../src/summary-service.js";

const prisma = createPostgresClient();
const episodicMemory = new EpisodicMemory(prisma);
const semanticMemoryStore = new SemanticMemoryStore(prisma);

interface TestOwner {
  tenantId: string;
  scope: ConversationScope;
}

async function createOwner(name: string): Promise<TestOwner> {
  const tenant = await prisma.tenant.create({ data: { name } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, externalId: randomUUID() },
  });
  const session = await prisma.session.create({
    data: { tenantId: tenant.id, userId: user.id, externalId: randomUUID() },
  });
  return {
    tenantId: tenant.id,
    scope: { tenantId: tenant.id, userId: user.id, sessionId: session.id },
  };
}

function createPromptBuilder(retrieved: RetrievedSemanticMemory[], tokenCounter?: ContextTokenCounter) {
  const summaries = new ConversationSummaryService(episodicMemory, {
    async generate() {
      throw new Error("The test prompt should not require summary generation");
    },
  });
  const compactor = new ConversationContextCompactor(
    episodicMemory,
    summaries,
    { inputTokenBudget: 10_000 },
    tokenCounter,
  );
  return new ConversationPromptBuilder(compactor, {
    async retrieve() {
      return retrieved;
    },
  });
}

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await prisma.$disconnect();
});

describe("ConversationTurnMemoryService", () => {
  it("leaves facts below the relevance threshold out of the prepared prompt", async () => {
    const owner = await createOwner("Relevance threshold test");
    const relevantId = randomUUID();
    const weakId = randomUUID();
    const facts = new Map<string, string>([
      [relevantId, "The user prefers Qdrant for semantic memory."],
      [weakId, "The user owns a cat."],
    ]);
    const retrieval = new SemanticMemoryRetrievalService(
      {
        async getById(_scope, memoryId) {
          const content = facts.get(memoryId);
          return content === undefined ? null : {
            id: memoryId,
            content,
            category: SemanticMemoryCategory.preference,
            status: SemanticMemoryStatus.active,
            sourceConversationId: randomUUID(),
            sourceMessageId: randomUUID(),
          };
        },
      },
      {
        async findSimilar() {
          return [
            { semanticMemoryId: relevantId, score: 0.82 },
            { semanticMemoryId: weakId, score: 0.31 },
          ];
        },
      },
    );
    const compactor = new ConversationContextCompactor(
      episodicMemory,
      new ConversationSummaryService(episodicMemory, {
        async generate() {
          throw new Error("The test prompt should not require summary generation");
        },
      }),
      { inputTokenBudget: 10_000 },
    );
    const service = new ConversationTurnMemoryService(
      episodicMemory,
      new ConversationPromptBuilder(compactor, retrieval, { limit: 5, scoreThreshold: 0.5 }),
      new AutomaticSemanticMemoryService({ async extract() { return []; } }, semanticMemoryStore),
    );

    try {
      const conversation = await episodicMemory.createConversation(owner.scope);
      const prepared = await service.prepareTurn(owner.scope, conversation.id, "System prompt", "Which vector database do I prefer?");

      assert.deepEqual(prepared.prompt.semanticMemories.map(({ semanticMemoryId }) => semanticMemoryId), [relevantId]);
      assert.ok(!prepared.prompt.messages[0]?.content.includes("owns a cat"));
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("prepares context for a host model and persists its response before extracting facts", async () => {
    const owner = await createOwner("Conversation turn lifecycle test");
    const remembered: RetrievedSemanticMemory = {
      semanticMemoryId: randomUUID(),
      content: "The user prefers Qdrant for semantic memory.",
      category: SemanticMemoryCategory.preference,
      sourceConversationId: randomUUID(),
      sourceMessageId: randomUUID(),
      score: 0.9,
    };
    const extractionInputs: ExtractionInput[] = [];
    const currentFact: Omit<SemanticFactCandidate, "sourceMessageId"> = {
      content: "The user wants vector database answers to mention Qdrant first.",
      category: SemanticMemoryCategory.preference,
      kind: "fact",
      durability: 0.9,
    };
    const automaticMemory = new AutomaticSemanticMemoryService({
      async extract(input) {
        extractionInputs.push(input);
        return [{ ...currentFact, sourceMessageId: input.target.id }];
      },
    }, semanticMemoryStore);
    const service = new ConversationTurnMemoryService(
      episodicMemory,
      createPromptBuilder([remembered]),
      automaticMemory,
    );

    try {
      const conversation = await episodicMemory.createConversation(owner.scope);
      const priorUser = await episodicMemory.appendMessage(owner.scope, conversation.id, {
        role: MessageRole.user,
        content: "I prefer Qdrant for semantic memory.",
      });
      const priorAssistant = await episodicMemory.appendMessage(owner.scope, conversation.id, {
        role: MessageRole.assistant,
        content: "I'll use Qdrant for semantic memory.",
      });

      const prepared = await service.prepareTurn(
        owner.scope,
        conversation.id,
        "You are a helpful assistant.",
        "Which vector database do I prefer?",
      );
      const hostModelMessages = prepared.prompt.messages;
      const hostModelResponse = await Promise.resolve(
        hostModelMessages[0]?.content.includes("Qdrant")
          ? "You prefer Qdrant for semantic memory."
          : "I don't know yet.",
      );
      const completed = await service.completeTurn(owner.scope, prepared, hostModelResponse);

      assert.equal(prepared.userMessage.role, MessageRole.user);
      assert.match(hostModelMessages[0]?.content ?? "", /The user prefers Qdrant for semantic memory/);
      assert.equal(hostModelMessages.at(-1)?.content, "Which vector database do I prefer?");
      assert.equal(completed.assistantMessage.content, hostModelResponse);
      assert.equal(completed.assistantMessage.role, MessageRole.assistant);
      assert.equal(completed.semanticMemory.status, "success");
      if (completed.semanticMemory.status !== "success") assert.fail("Expected extraction to succeed");
      assert.equal(completed.semanticMemory.result.saved.length, 1);
      assert.equal(completed.semanticMemory.result.saved[0]?.sourceMessageId, prepared.userMessage.id);
      assert.deepEqual(
        { id: extractionInputs[0]?.target.id, role: extractionInputs[0]?.target.role, content: extractionInputs[0]?.target.content },
        { id: prepared.userMessage.id, role: "user", content: "Which vector database do I prefer?" },
      );
      assert.deepEqual(extractionInputs[0]?.context.map(({ id, role, content }) => ({ id, role, content })), [
        { id: priorUser.id, role: "user", content: "I prefer Qdrant for semantic memory." },
        { id: priorAssistant.id, role: "assistant", content: "I'll use Qdrant for semantic memory." },
      ]);
      assert.equal(
        [...(extractionInputs[0]?.context ?? []), extractionInputs[0]?.target]
          .some((message) => message?.content === hostModelResponse),
        false,
        "the generated assistant answer is not evidence for this turn's facts",
      );
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("passes the extractor only the newest user message as target and at most 4 earlier messages", async () => {
    const owner = await createOwner("Conversation turn extraction window test");
    const inputs: ExtractionInput[] = [];
    const service = new ConversationTurnMemoryService(
      episodicMemory,
      createPromptBuilder([]),
      new AutomaticSemanticMemoryService({
        async extract(input) { inputs.push(input); return []; },
      }, semanticMemoryStore),
    );

    try {
      const conversation = await episodicMemory.createConversation(owner.scope);
      const earlier = [];
      for (let index = 0; index < 6; index += 1) {
        earlier.push(await episodicMemory.appendMessage(owner.scope, conversation.id, {
          role: index % 2 === 0 ? MessageRole.user : MessageRole.assistant,
          content: `Earlier message ${index}`,
        }));
      }
      const prepared = await service.prepareTurn(owner.scope, conversation.id, "System.", "I'm vegetarian.");
      await service.completeTurn(owner.scope, prepared, "Noted.");

      assert.equal(inputs[0]?.target.id, prepared.userMessage.id);
      assert.deepEqual(inputs[0]?.context.map(({ id }) => id), earlier.slice(-4).map(({ id }) => id));
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("returns the saved assistant response when semantic extraction fails", async () => {
    const owner = await createOwner("Conversation turn extraction failure test");
    const service = new ConversationTurnMemoryService(
      episodicMemory,
      createPromptBuilder([]),
      {
        async extractAndSave() {
          throw new Error("Groq extraction unavailable");
        },
      },
    );

    try {
      const conversation = await episodicMemory.createConversation(owner.scope);
      const prepared = await service.prepareTurn(owner.scope, conversation.id, "System prompt", "Remember my preference.");
      const completed = await service.completeTurn(owner.scope, prepared, "I will remember it.");
      const persisted = await episodicMemory.listMessages(owner.scope, conversation.id);

      assert.equal(completed.assistantMessage.content, "I will remember it.");
      assert.deepEqual(completed.semanticMemory, { status: "failed", error: "Groq extraction unavailable" });
      assert.equal(persisted.at(-1)?.id, completed.assistantMessage.id);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("rejects completing a prepared turn under another user's scope", async () => {
    const owner = await createOwner("Prepared turn owner");
    const otherOwner = await createOwner("Different prepared turn owner");
    const service = new ConversationTurnMemoryService(
      episodicMemory,
      createPromptBuilder([]),
      { async extractAndSave() { throw new Error("Must not run"); } },
    );

    try {
      const conversation = await episodicMemory.createConversation(owner.scope);
      const prepared = await service.prepareTurn(owner.scope, conversation.id, "System prompt", "Hello.");

      await assert.rejects(
        service.completeTurn(otherOwner.scope, prepared, "Hello back."),
        PreparedConversationTurnError,
      );
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
      await prisma.tenant.delete({ where: { id: otherOwner.tenantId } });
    }
  });

  it("rejects a second completion when two replies race for the same prepared turn", async () => {
    const owner = await createOwner("Concurrent turn completion test");
    const service = new ConversationTurnMemoryService(
      episodicMemory,
      createPromptBuilder([]),
      {
        async extractAndSave() {
          return { extracted: [], saved: [], skipped: [], supersededMemoryIds: [] };
        },
      },
    );

    try {
      const conversation = await episodicMemory.createConversation(owner.scope);
      const prepared = await service.prepareTurn(owner.scope, conversation.id, "System prompt", "Tell me about recall.");
      const results = await Promise.allSettled([
        service.completeTurn(owner.scope, prepared, "First reply."),
        service.completeTurn(owner.scope, prepared, "Duplicate reply."),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      const messages = await episodicMemory.listMessages(owner.scope, conversation.id);

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0]?.status === "rejected" && rejected[0].reason instanceof ConversationTurnOrderError);
      assert.equal(messages.filter(({ role }) => role === MessageRole.assistant).length, 1);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });
});
