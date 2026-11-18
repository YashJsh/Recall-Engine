import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { MessageRole, SemanticMemoryCategory } from "../src/generated/prisma/enums.js";
import { EpisodicMemory, type ConversationScope } from "../src/episodic-memory.js";
import { createPostgresClient } from "../src/postgres-client.js";
import {
  SemanticMemorySourceError,
  SemanticMemorySupersessionError,
  SemanticMemoryStore,
} from "../src/semantic-memory.js";

const prisma = createPostgresClient();
const episodicMemory = new EpisodicMemory(prisma);
const semanticMemory = new SemanticMemoryStore(prisma);

interface TestOwner {
  tenantId: string;
  scope: Pick<ConversationScope, "tenantId" | "userId">;
  sessionId: string;
  conversationId: string;
  sourceMessageId: string;
}

async function createUserInTenant(tenantId: string): Promise<TestOwner> {
  const user = await prisma.user.create({ data: { tenantId, externalId: randomUUID() } });
  const session = await prisma.session.create({
    data: { tenantId, userId: user.id, externalId: randomUUID() },
  });
  const scope = { tenantId, userId: user.id };
  const conversationScope = { ...scope, sessionId: session.id };
  const conversation = await episodicMemory.createConversation(conversationScope);
  const sourceMessage = await episodicMemory.appendMessage(
    conversationScope,
    conversation.id,
    { role: MessageRole.user, content: "I prefer Redis for working memory." },
  );
  return {
    tenantId,
    scope,
    sessionId: session.id,
    conversationId: conversation.id,
    sourceMessageId: sourceMessage.id,
  };
}

async function createOwner(): Promise<TestOwner> {
  const tenant = await prisma.tenant.create({ data: { name: "Semantic memory test" } });
  return createUserInTenant(tenant.id);
}

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await prisma.$disconnect();
});

describe("SemanticMemoryStore", () => {
  it("creates a fact and traces it to its exact source message", async () => {
    const owner = await createOwner();
    try {
      const fact = await semanticMemory.create(owner.scope, {
        content: "The user prefers Redis for working memory.",
        category: SemanticMemoryCategory.preference,
        sourceConversationId: owner.conversationId,
        sourceMessageId: owner.sourceMessageId,
      });
      const fetched = await semanticMemory.getById(owner.scope, fact.id);

      assert.notEqual(fact.id, owner.sourceMessageId);
      assert.equal(fact.status, "active");
      assert.equal(fact.content, "The user prefers Redis for working memory.");
      assert.equal(fact.sourceMessage.id, owner.sourceMessageId);
      assert.equal(fact.sourceMessage.content, "I prefer Redis for working memory.");
      assert.equal(fact.sourceMessage.conversation.id, owner.conversationId);
      assert.equal(fetched?.id, fact.id);
      assert.equal(fetched?.sourceMessage.id, owner.sourceMessageId);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("rejects a missing source message", async () => {
    const owner = await createOwner();
    try {
      await assert.rejects(
        semanticMemory.create(owner.scope, {
          content: "The user prefers Redis for working memory.",
          category: SemanticMemoryCategory.preference,
          sourceConversationId: owner.conversationId,
          sourceMessageId: randomUUID(),
        }),
        SemanticMemorySourceError,
      );
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("rejects a malformed source message ID", async () => {
    const owner = await createOwner();
    try {
      await assert.rejects(
        semanticMemory.create(owner.scope, {
          content: "The user prefers Redis for working memory.",
          category: SemanticMemoryCategory.preference,
          sourceConversationId: owner.conversationId,
          sourceMessageId: "not-a-uuid",
        }),
        SemanticMemorySourceError,
      );
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("rejects a source message owned by another user", async () => {
    const owner = await createOwner();
    try {
      const otherUser = await createUserInTenant(owner.tenantId);
      await assert.rejects(
        semanticMemory.create(owner.scope, {
          content: "The user prefers Redis for working memory.",
          category: SemanticMemoryCategory.preference,
          sourceConversationId: otherUser.conversationId,
          sourceMessageId: otherUser.sourceMessageId,
        }),
        SemanticMemorySourceError,
      );
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("rejects an assistant message as fact provenance", async () => {
    const owner = await createOwner();
    try {
      const assistantMessage = await episodicMemory.appendMessage(
        { ...owner.scope, sessionId: owner.sessionId },
        owner.conversationId,
        { role: MessageRole.assistant, content: "The user prefers Redis." },
      );

      await assert.rejects(
        semanticMemory.create(owner.scope, {
          content: "The user prefers Redis.",
          category: SemanticMemoryCategory.preference,
          sourceConversationId: owner.conversationId,
          sourceMessageId: assistantMessage.id,
        }),
        SemanticMemorySourceError,
      );
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("rejects a message from a different conversation", async () => {
    const owner = await createOwner();
    try {
      const otherConversation = await episodicMemory.createConversation({
        ...owner.scope,
        sessionId: owner.sessionId,
      });
      await assert.rejects(
        semanticMemory.create(owner.scope, {
          content: "The user prefers Redis for working memory.",
          category: SemanticMemoryCategory.preference,
          sourceConversationId: otherConversation.id,
          sourceMessageId: owner.sourceMessageId,
        }),
        SemanticMemorySourceError,
      );
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("scopes ID lookup to tenant and user", async () => {
    const owner = await createOwner();
    const otherTenant = await createOwner();
    try {
      const fact = await semanticMemory.create(owner.scope, {
        content: "The user prefers Redis for working memory.",
        category: SemanticMemoryCategory.preference,
        sourceConversationId: owner.conversationId,
        sourceMessageId: owner.sourceMessageId,
      });
      const otherUser = await createUserInTenant(owner.tenantId);

      assert.equal(await semanticMemory.getById(otherUser.scope, fact.id), null);
      assert.equal(await semanticMemory.getById(otherTenant.scope, fact.id), null);
      assert.equal(await semanticMemory.getById(owner.scope, "not-a-uuid"), null);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
      await prisma.tenant.delete({ where: { id: otherTenant.tenantId } });
    }
  });

  it("supersedes a fact and retains the predecessor", async () => {
    const owner = await createOwner();
    try {
      const previous = await semanticMemory.create(owner.scope, {
        content: "The user prefers Redis for working memory.",
        category: SemanticMemoryCategory.preference,
        sourceConversationId: owner.conversationId,
        sourceMessageId: owner.sourceMessageId,
      });
      const current = await semanticMemory.create(owner.scope, {
        content: "The user now prefers PostgreSQL for working memory.",
        category: SemanticMemoryCategory.preference,
        sourceConversationId: owner.conversationId,
        sourceMessageId: owner.sourceMessageId,
        supersedesMemoryId: previous.id,
      });
      const retainedPrevious = await semanticMemory.getById(owner.scope, previous.id);

      assert.notEqual(current.id, previous.id);
      assert.equal(current.supersedesMemoryId, previous.id);
      assert.equal(current.status, "active");
      assert.equal(retainedPrevious?.status, "superseded");
      assert.equal(retainedPrevious?.sourceMessage.id, owner.sourceMessageId);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("rejects invalid supersession targets", async () => {
    const owner = await createOwner();
    try {
      const otherUser = await createUserInTenant(owner.tenantId);
      const foreignFact = await semanticMemory.create(otherUser.scope, {
        content: "Another user's fact.",
        category: SemanticMemoryCategory.preference,
        sourceConversationId: otherUser.conversationId,
        sourceMessageId: otherUser.sourceMessageId,
      });
      const previous = await semanticMemory.create(owner.scope, {
        content: "The user prefers Redis for working memory.",
        category: SemanticMemoryCategory.preference,
        sourceConversationId: owner.conversationId,
        sourceMessageId: owner.sourceMessageId,
      });
      await semanticMemory.create(owner.scope, {
        content: "The user now prefers PostgreSQL for working memory.",
        category: SemanticMemoryCategory.preference,
        sourceConversationId: owner.conversationId,
        sourceMessageId: owner.sourceMessageId,
        supersedesMemoryId: previous.id,
      });

      const createSupersedingFact = (supersedesMemoryId: string) => semanticMemory.create(owner.scope, {
        content: "The user now prefers a different database.",
        category: SemanticMemoryCategory.preference,
        sourceConversationId: owner.conversationId,
        sourceMessageId: owner.sourceMessageId,
        supersedesMemoryId,
      });

      await assert.rejects(createSupersedingFact(randomUUID()), SemanticMemorySupersessionError);
      await assert.rejects(createSupersedingFact("not-a-uuid"), SemanticMemorySupersessionError);
      await assert.rejects(createSupersedingFact(foreignFact.id), SemanticMemorySupersessionError);
      await assert.rejects(createSupersedingFact(previous.id), SemanticMemorySupersessionError);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });
});
