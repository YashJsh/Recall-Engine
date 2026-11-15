import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { MessageRole } from "../src/generated/prisma/enums.js";
import {
  EpisodicMemory,
  SummaryCheckpointError,
  type ConversationScope,
} from "../src/episodic-memory.js";
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

  it("stores versioned summaries with message checkpoints and rejects stale checkpoints", async () => {
    const owner = await createOwner();
    try {
      const conversation = await memory.createConversation(owner.scope);
      await memory.appendMessage(owner.scope, conversation.id, {
        role: MessageRole.user,
        content: "I prefer concise updates.",
      });
      await memory.appendMessage(owner.scope, conversation.id, {
        role: MessageRole.assistant,
        content: "I will keep updates concise.",
      });

      const first = await memory.saveSummary(owner.scope, conversation.id, {
        summaryText: "The user prefers concise updates.",
        throughSequenceNo: 1,
      });
      const second = await memory.saveSummary(owner.scope, conversation.id, {
        summaryText: "The user prefers concise updates; the assistant agreed.",
        throughSequenceNo: 2,
      });

      assert.equal(first.version, 1);
      assert.equal(second.version, 2);
      assert.equal(second.throughSequenceNo, 2);
      assert.equal((await memory.getLatestSummary(owner.scope, conversation.id))?.id, second.id);
      assert.equal(
        await memory.getLatestSummary({ ...owner.scope, userId: randomUUID() }, conversation.id),
        null,
      );
      assert.deepEqual(
        (await memory.listSummaryVersions(owner.scope, conversation.id)).map(({ version }) => version),
        [1, 2],
      );
      await assert.rejects(
        memory.saveSummary(owner.scope, conversation.id, {
          summaryText: "Out of date summary.",
          throughSequenceNo: 1,
        }),
        SummaryCheckpointError,
      );
      await assert.rejects(
        memory.saveSummary(owner.scope, conversation.id, {
          summaryText: "A summary of messages that do not exist.",
          throughSequenceNo: 3,
        }),
        SummaryCheckpointError,
      );
      assert.equal((await memory.getLatestSummary(owner.scope, conversation.id))?.id, second.id);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });
});
