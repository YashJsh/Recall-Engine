import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPostgresClient } from "../src/postgres-client.js";
import { connectRecallEngine, RecallEngineConnectionError } from "../src/index.js";

const prisma = createPostgresClient();

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
    const engine = await connectRecallEngine({ contextInputTokenBudget: 10_000 });

    try {
      const conversation = await engine.conversations.create(scope, "Public API test");
      const prepared = await engine.conversations.prepareTurn({
        scope,
        conversationId: conversation.id,
        systemPrompt: "Answer clearly.",
        userMessage: "Hello from the public API test.",
      });

      const hostModelReply = prepared.prompt.messages.at(-1)?.content === "Hello from the public API test."
        ? "Hello from the host model."
        : "Unexpected prompt contents.";
      const completed = await engine.conversations.completeTurn({
        scope,
        preparedTurn: prepared,
        assistantContent: hostModelReply,
      });
      const messages = await engine.conversations.listMessages(scope, conversation.id);

      assert.equal(prepared.prompt.messages.at(-1)?.content, "Hello from the public API test.");
      assert.equal(completed.assistantMessage.content, "Hello from the host model.");
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.role, "user");
      assert.equal(messages[1]?.role, "assistant");
      if (completed.semanticMemory.status === "success") {
        assert.ok(Array.isArray(completed.semanticMemory.result.saved));
      } else {
        assert.equal(typeof completed.semanticMemory.error, "string");
      }

      await engine.workingMemory.addItem(scope, {
        id: "task-context",
        content: "The host app owns the model call.",
        tokenCount: 8,
        priority: 1,
      });
      assert.equal((await engine.workingMemory.getItems(scope))[0]?.id, "task-context");
      await engine.workingMemory.clearSession(scope);
    } finally {
      await engine.close();
      await prisma.tenant.delete({ where: { id: tenant.id } });
    }
  });

  it("checks required storage services before returning an engine", async () => {
    await assert.rejects(
      connectRecallEngine({ qdrantUrl: "http://127.0.0.1:1" }),
      RecallEngineConnectionError,
    );
    const recovered = await connectRecallEngine();
    await recovered.close();
  });
});
