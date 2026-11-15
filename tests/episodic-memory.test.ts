import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { MessageRole } from "../src/generated/prisma/enums.js";
import { EpisodicMemory, type ConversationScope } from "../src/episodic-memory.js";
import { createPostgresClient } from "../src/postgres-client.js";

const prisma = createPostgresClient();
const memory = new EpisodicMemory(prisma);

interface TestOwner {
  scope: ConversationScope;
  tenantId: string;
}

async function createOwner(): Promise<TestOwner> {
  const tenant = await prisma.tenant.create({ data: { name: "Episodic memory test" } });
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

before(async () => {
  await prisma.$connect();
});

after(async () => {
  await prisma.$disconnect();
});

describe("EpisodicMemory", () => {
  it("persists exact messages in sequence, paginates, and isolates their owner", async () => {
    const owner = await createOwner();
    try {
      const conversation = await memory.createConversation(owner.scope, "Planning");
      const contents = ["first exact message", "second exact message", "third exact message"];
      await Promise.all(contents.map((content) => memory.appendMessage(
        owner.scope,
        conversation.id,
        { role: MessageRole.user, content },
      )));

      const firstPage = await memory.listMessages(owner.scope, conversation.id, { limit: 2 });
      const secondPage = await memory.listMessages(owner.scope, conversation.id, {
        afterSequenceNo: 2,
        limit: 2,
      });
      const otherUserScope = { ...owner.scope, userId: randomUUID() };

      assert.deepEqual(firstPage.map(({ sequenceNo }) => sequenceNo), [1, 2]);
      assert.deepEqual(secondPage.map(({ sequenceNo }) => sequenceNo), [3]);
      assert.deepEqual(
        [...firstPage, ...secondPage].map(({ content }) => content).sort(),
        [...contents].sort(),
      );
      assert.deepEqual(await memory.listMessages(otherUserScope, conversation.id), []);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });
});
