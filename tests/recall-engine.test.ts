import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createClient } from "redis";
import { createPostgresClient } from "../src/postgres-client.js";
import {
  connectRecallEngine,
  ConversationPromptPreparationError,
  ConversationTurnOrderError,
  RecallEngineConnectionError,
} from "../src/index.js";

const prisma = createPostgresClient();

async function countRecallEngineRedisConnections(): Promise<number> {
  const client = createClient({ url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" });
  await client.connect();
  try {
    const listing = String(await client.sendCommand(["CLIENT", "LIST"]));
    return listing.split("\n").filter((entry) => entry.includes("name=recall-engine")).length;
  } finally {
    await client.quit();
  }
}

async function countRecallEnginePostgresConnections(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count
    FROM pg_stat_activity
    WHERE application_name = 'recall-engine'
  `;
  return Number(rows[0]?.count ?? 0);
}

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await prisma.$disconnect();
});

describe("Recall Engine public API", () => {
  it("connects the memory stores and completes a host-owned conversation turn", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Recall Engine API test" } });
    const user = await prisma.user.create({ data: { tenantId: tenant.id, externalId: randomUUID() } });
    const session = await prisma.session.create({
      data: { tenantId: tenant.id, userId: user.id, externalId: randomUUID() },
    });
    const scope = { tenantId: tenant.id, userId: user.id, sessionId: session.id };
    const engine = await connectRecallEngine({
      contextInputTokenBudget: 10_000,
      workingMemoryTokenBudget: 10,
      workingMemorySessionTtlMs: 120,
    });

    try {
      const conversation = await engine.conversations.create(scope, "Public API test");
      const prepared = await engine.conversations.prepareTurn({
        scope,
        conversationId: conversation.id,
        systemPrompt: "Answer clearly.",
        userMessage: "I prefer Redis for working memory.",
      });

      const hostModelReply = prepared.prompt.messages.at(-1)?.content === "I prefer Redis for working memory."
        ? "Hello from the host model."
        : "Unexpected prompt contents.";
      const configuredGroqKey = process.env.GROQ_API_KEY;
      process.env.GROQ_API_KEY = "";
      let completed;
      try {
        completed = await engine.conversations.completeTurn({
          scope,
          preparedTurn: prepared,
          assistantContent: hostModelReply,
        });
      } finally {
        if (configuredGroqKey === undefined) delete process.env.GROQ_API_KEY;
        else process.env.GROQ_API_KEY = configuredGroqKey;
      }
      const messages = await engine.conversations.listMessages(scope, conversation.id);

      assert.equal(prepared.prompt.messages.at(-1)?.content, "I prefer Redis for working memory.");
      assert.equal(completed.assistantMessage.content, "Hello from the host model.");
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.role, "user");
      assert.equal(messages[1]?.role, "assistant");
      assert.equal(completed.semanticMemory.status, "failed");
      if (completed.semanticMemory.status !== "failed") assert.fail("Expected extraction to report the missing key");
      assert.match(completed.semanticMemory.error, /GROQ_API_KEY must be set/);

      await engine.workingMemory.addItem(scope, {
        id: "low-priority",
        content: "Keep briefly.",
        tokenCount: 8,
        priority: 1,
      });
      const itemResult = await engine.workingMemory.addItem(scope, {
        id: "high-priority",
        content: "Keep this.",
        tokenCount: 5,
        priority: 2,
      });
      assert.deepEqual(itemResult.evicted, ["low-priority"]);
      assert.equal(await engine.workingMemory.getTokenUsage(scope), 5);
      await engine.workingMemory.clearSession(scope);

      const savedFact = await engine.semanticMemory.saveFact({
        scope: { tenantId: scope.tenantId, userId: scope.userId },
        content: "The user prefers Redis for working memory.",
        category: "preference",
        sourceConversationId: conversation.id,
        sourceMessageId: messages[0]!.id,
      });
      const retrieved = await engine.semanticMemory.retrieve(
        { tenantId: scope.tenantId, userId: scope.userId },
        "Which database should I use for working memory?",
      );
      const tracedFact = await engine.semanticMemory.getById(
        { tenantId: scope.tenantId, userId: scope.userId },
        savedFact.id,
      );
      const otherUserMatches = await engine.semanticMemory.retrieve(
        { tenantId: scope.tenantId, userId: randomUUID() },
        "Which database should I use for working memory?",
      );

      assert.equal(retrieved[0]?.semanticMemoryId, savedFact.id);
      assert.equal(tracedFact?.sourceConversationId, conversation.id);
      assert.equal(tracedFact?.sourceMessageId, messages[0]?.id);
      assert.deepEqual(otherUserMatches, []);

      const expiringScope = { ...scope, sessionId: randomUUID() };
      await engine.workingMemory.addItem(expiringScope, {
        id: "expires",
        content: "Temporary item",
        tokenCount: 1,
        priority: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.deepEqual(await engine.workingMemory.getItems(expiringScope), []);
    } finally {
      await engine.close();
      await prisma.tenant.delete({ where: { id: tenant.id } });
    }
  });

  it("checks required storage services before returning an engine", async () => {
    assert.equal(await countRecallEngineRedisConnections(), 0);
    assert.equal(await countRecallEnginePostgresConnections(), 0);
    await assert.rejects(
      connectRecallEngine({ databaseUrl: "postgresql://recall:bad@127.0.0.1:1/recall_engine" }),
      RecallEngineConnectionError,
    );
    assert.equal(await countRecallEngineRedisConnections(), 0);
    assert.equal(await countRecallEnginePostgresConnections(), 0);

    await assert.rejects(
      connectRecallEngine({ redisUrl: "redis://127.0.0.1:1" }),
      RecallEngineConnectionError,
    );
    assert.equal(await countRecallEngineRedisConnections(), 0);
    assert.equal(await countRecallEnginePostgresConnections(), 0);

    await assert.rejects(
      connectRecallEngine({ qdrantUrl: "http://127.0.0.1:1" }),
      RecallEngineConnectionError,
    );
    assert.equal(await countRecallEngineRedisConnections(), 0);
    assert.equal(await countRecallEnginePostgresConnections(), 0);

    const recovered = await connectRecallEngine();
    assert.equal(await countRecallEngineRedisConnections(), 1);
    assert.equal(await countRecallEnginePostgresConnections(), 1);
    await recovered.close();
    assert.equal(await countRecallEngineRedisConnections(), 0);
    assert.equal(await countRecallEnginePostgresConnections(), 0);
  });

  it("resumes prompt preparation from its persisted user message without duplicating it", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Recall Engine recovery test" } });
    const user = await prisma.user.create({ data: { tenantId: tenant.id, externalId: randomUUID() } });
    const session = await prisma.session.create({
      data: { tenantId: tenant.id, userId: user.id, externalId: randomUUID() },
    });
    const scope = { tenantId: tenant.id, userId: user.id, sessionId: session.id };
    const conversationId = (await prisma.conversation.create({ data: scope })).id;
    const failedEngine = await connectRecallEngine({ contextInputTokenBudget: 1_500 });
    const longMessage = `I prefer Redis for working memory. ${"Extra context. ".repeat(1_600)}`;
    let preparationError: ConversationPromptPreparationError | undefined;

    try {
      await failedEngine.conversations.prepareTurn({
        scope,
        conversationId,
        systemPrompt: "Answer clearly.",
        userMessage: longMessage,
      });
    } catch (error) {
      if (error instanceof ConversationPromptPreparationError) preparationError = error;
      else throw error;
    } finally {
      await failedEngine.close();
    }

    assert.ok(preparationError);
    assert.ok(preparationError.persistedUserMessageId);
    const recoveryEngine = await connectRecallEngine({ contextInputTokenBudget: 12_000 });
    try {
      const resumed = await recoveryEngine.conversations.prepareTurn({
        scope,
        conversationId,
        systemPrompt: "Answer clearly.",
        userMessage: longMessage,
        resumeUserMessageId: preparationError.persistedUserMessageId,
      });
      const messages = await recoveryEngine.conversations.listMessages(scope, conversationId);

      assert.equal(resumed.userMessage.id, preparationError.persistedUserMessageId);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.content, longMessage);

      await recoveryEngine.conversations.prepareTurn({
        scope,
        conversationId,
        systemPrompt: "Answer clearly.",
        userMessage: "A later turn arrived.",
      });
      await assert.rejects(
        recoveryEngine.conversations.prepareTurn({
          scope,
          conversationId,
          systemPrompt: "Answer clearly.",
          userMessage: longMessage,
          resumeUserMessageId: preparationError.persistedUserMessageId,
        }),
        ConversationTurnOrderError,
      );
    } finally {
      await recoveryEngine.close();
      await prisma.tenant.delete({ where: { id: tenant.id } });
    }
  });
});
