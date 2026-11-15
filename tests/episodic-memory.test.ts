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
import {
  ConversationSummaryService,
  SummaryInputTooLargeError,
  type SummaryGenerationInput,
  type SummaryGenerator,
} from "../src/summary-service.js";

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

  it("summarizes only new messages and carries the previous summary forward", async () => {
    const owner = await createOwner();
    try {
      const conversation = await memory.createConversation(owner.scope);
      const generatedInputs: SummaryGenerationInput[] = [];
      const generator: SummaryGenerator = {
        async generate(input) {
          generatedInputs.push(input);
          return `summary-${generatedInputs.length}`;
        },
      };
      const summaries = new ConversationSummaryService(memory, generator);

      for (const content of ["message 1", "message 2"]) {
        await memory.appendMessage(owner.scope, conversation.id, {
          role: MessageRole.user,
          content,
        });
      }
      const first = await summaries.summarizeThrough(owner.scope, conversation.id, 2);

      for (const content of ["message 3", "message 4"]) {
        await memory.appendMessage(owner.scope, conversation.id, {
          role: MessageRole.assistant,
          content,
        });
      }
      const second = await summaries.summarizeThrough(owner.scope, conversation.id, 4);

      assert.equal(first.summaryText, "summary-1");
      assert.equal(second.summaryText, "summary-2");
      assert.equal(second.version, 2);
      assert.deepEqual(generatedInputs[0].messages.map(({ sequenceNo }) => sequenceNo), [1, 2]);
      assert.deepEqual(generatedInputs[1].messages.map(({ sequenceNo }) => sequenceNo), [3, 4]);
      assert.equal(generatedInputs[1].previousSummary, "summary-1");
      await assert.rejects(
        summaries.summarizeThrough(owner.scope, conversation.id, 5),
        SummaryCheckpointError,
      );
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("does not call the generator when the selected message range is too large", async () => {
    const owner = await createOwner();
    try {
      const conversation = await memory.createConversation(owner.scope);
      await memory.appendMessage(owner.scope, conversation.id, {
        role: MessageRole.user,
        content: "message 1",
      });
      await memory.appendMessage(owner.scope, conversation.id, {
        role: MessageRole.user,
        content: "message 2",
      });
      let generatorCalled = false;
      const generator: SummaryGenerator = {
        async generate() {
          generatorCalled = true;
          return "should not be called";
        },
      };
      const summaries = new ConversationSummaryService(memory, generator, {
        maxMessagesPerSummary: 1,
      });

      await assert.rejects(
        summaries.summarizeThrough(owner.scope, conversation.id, 2),
        SummaryInputTooLargeError,
      );
      assert.equal(generatorCalled, false);
      assert.equal(await memory.getLatestSummary(owner.scope, conversation.id), null);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });
});
