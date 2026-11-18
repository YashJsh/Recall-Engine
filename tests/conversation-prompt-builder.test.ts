import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MessageRole, SemanticMemoryCategory } from "../src/generated/prisma/enums.js";
import { ConversationPromptBuilder } from "../src/conversation-prompt-builder.js";
import {
  ConversationContextCompactor,
  type ContextTokenCounter,
  type PromptMessage,
} from "../src/context-compaction.js";
import { EpisodicMemory, type ConversationScope } from "../src/episodic-memory.js";
import { createPostgresClient } from "../src/postgres-client.js";
import type { RetrievedSemanticMemory } from "../src/semantic-memory-retrieval.js";
import { ConversationSummaryService } from "../src/summary-service.js";

const prisma = createPostgresClient();
const episodicMemory = new EpisodicMemory(prisma);

interface TestOwner {
  tenantId: string;
  scope: ConversationScope;
}

async function createOwner(): Promise<TestOwner> {
  const tenant = await prisma.tenant.create({ data: { name: "Conversation prompt builder test" } });
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

function createCompactor(tokenCounter: ContextTokenCounter) {
  const summaries = new ConversationSummaryService(episodicMemory, {
    async generate() {
      throw new Error("The test prompt should not require summary generation");
    },
  });
  return new ConversationContextCompactor(episodicMemory, summaries, {
    inputTokenBudget: 10_000,
  }, tokenCounter);
}

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await prisma.$disconnect();
});

describe("ConversationPromptBuilder", () => {
  it("places retrieved memories, system instructions, and persisted conversation history in model messages", async () => {
    const owner = await createOwner();
    const currentUserMessage = "Which vector database did I choose for semantic memory?";
    const remembered: RetrievedSemanticMemory = {
      semanticMemoryId: randomUUID(),
      content: "The user prefers Qdrant for semantic memory.",
      category: SemanticMemoryCategory.preference,
      sourceConversationId: randomUUID(),
      sourceMessageId: randomUUID(),
      score: 0.83,
    };
    const countedPrompts: PromptMessage[][] = [];
    const tokenCounter: ContextTokenCounter = {
      count(messages) {
        countedPrompts.push(messages);
        return messages.reduce((total, message) => total + message.content.length, 0);
      },
    };
    let receivedScope;
    let receivedQuery: string | undefined;
    const builder = new ConversationPromptBuilder(createCompactor(tokenCounter), {
      async retrieve(scope, queryText) {
        receivedScope = scope;
        receivedQuery = queryText;
        return [remembered];
      },
    });

    try {
      const conversation = await episodicMemory.createConversation(owner.scope);
      await episodicMemory.appendMessage(owner.scope, conversation.id, {
        role: MessageRole.user,
        content: "We are setting up semantic memory.",
      });
      await episodicMemory.appendMessage(owner.scope, conversation.id, {
        role: MessageRole.assistant,
        content: "We have compared vector databases.",
      });
      await episodicMemory.appendMessage(owner.scope, conversation.id, {
        role: MessageRole.user,
        content: currentUserMessage,
      });

      const result = await builder.build(
        owner.scope,
        conversation.id,
        "You are a helpful assistant.",
        currentUserMessage,
      );

      assert.deepEqual(receivedScope, { tenantId: owner.scope.tenantId, userId: owner.scope.userId });
      assert.equal(receivedQuery, currentUserMessage);
      assert.equal(result.semanticMemories[0]?.semanticMemoryId, remembered.semanticMemoryId);
      assert.equal(result.messages[0]?.role, "system");
      assert.match(result.messages[0]?.content ?? "", /You are a helpful assistant\./);
      assert.match(result.messages[0]?.content ?? "", /untrusted reference data/);
      assert.match(result.messages[0]?.content ?? "", /Qdrant for semantic memory/);
      assert.deepEqual(result.messages.slice(1).map(({ role, content }) => ({ role, content })), [
        { role: "user", content: "We are setting up semantic memory." },
        { role: "assistant", content: "We have compared vector databases." },
        { role: "user", content: currentUserMessage },
      ]);
      assert.ok(countedPrompts.some(([system]) => system?.content.includes("Qdrant for semantic memory")));
      assert.equal(result.tokenCount, countedPrompts.at(-1)?.reduce(
        (total, message) => total + message.content.length,
        0,
      ));
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("builds the normal conversation prompt without adding a memory section when retrieval is empty", async () => {
    const owner = await createOwner();
    const builder = new ConversationPromptBuilder(createCompactor({
      count: (messages) => messages.reduce((total, message) => total + message.content.length, 0),
    }), {
      async retrieve() {
        return [];
      },
    });

    try {
      const conversation = await episodicMemory.createConversation(owner.scope);
      await episodicMemory.appendMessage(owner.scope, conversation.id, {
        role: MessageRole.user,
        content: "Hello.",
      });

      const result = await builder.build(owner.scope, conversation.id, "You are helpful.", "Hello.");

      assert.deepEqual(result.semanticMemories, []);
      assert.equal(result.messages[0]?.content, "You are helpful.");
      assert.equal(result.messages[1]?.content, "Hello.");
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("rejects an empty current user message before retrieval", async () => {
    let retrievalCalled = false;
    const builder = new ConversationPromptBuilder(createCompactor({ count: () => 0 }), {
      async retrieve() {
        retrievalCalled = true;
        return [];
      },
    });

    await assert.rejects(
      builder.build({ tenantId: "tenant", userId: "user", sessionId: "session" }, "conversation", "System", " "),
      /currentUserMessage must not be empty/,
    );
    assert.equal(retrievalCalled, false);
  });
});
