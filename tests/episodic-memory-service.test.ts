import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MessageRole, SemanticMemoryCategory } from "../src/generated/prisma/enums.js";
import { ConversationPromptBuilder } from "../src/conversation-prompt-builder.js";
import { ConversationContextCompactor } from "../src/context-compaction.js";
import { EpisodeRetrievalService } from "../src/episode-retrieval.js";
import { EpisodeStore } from "../src/episode-store.js";
import type { EpisodeVectorInput } from "../src/episode-vector-store.js";
import { EpisodicMemory, type ConversationScope } from "../src/episodic-memory.js";
import { IndexedEpisodeWriter } from "../src/episodic-memory-service.js";
import { createPostgresClient } from "../src/postgres-client.js";
import type { SemanticFactCandidate } from "../src/semantic-fact-extractor.js";
import { AutomaticSemanticMemoryService } from "../src/semantic-memory-extraction-service.js";
import { SemanticMemoryStore } from "../src/semantic-memory.js";
import { ConversationSummaryService } from "../src/summary-service.js";

const prisma = createPostgresClient();
const transcript = new EpisodicMemory(prisma);
const episodeStore = new EpisodeStore(prisma);
const semanticStore = new SemanticMemoryStore(prisma);

/** In-memory stand-in for the Qdrant episode index: no vectors are left behind by tests. */
class FakeEpisodeIndex {
  readonly indexed: EpisodeVectorInput[] = [];
  async index(episode: EpisodeVectorInput) { this.indexed.push(episode); }
  async findSimilar(scope: { tenantId: string; userId: string }) {
    return this.indexed
      .filter((episode) => episode.tenantId === scope.tenantId && episode.userId === scope.userId)
      .map((episode) => ({ episodeId: episode.id, score: 0.9 }));
  }
}

interface Owner { tenantId: string; scope: ConversationScope }

async function createOwner(): Promise<Owner> {
  const tenant = await prisma.tenant.create({ data: { name: "Episodic memory test" } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, externalId: randomUUID() } });
  const session = await prisma.session.create({ data: { tenantId: tenant.id, userId: user.id, externalId: randomUUID() } });
  return { tenantId: tenant.id, scope: { tenantId: tenant.id, userId: user.id, sessionId: session.id } };
}

async function conversationWith(scope: ConversationScope, contents: string[]) {
  const conversation = await transcript.createConversation(scope);
  const messages = [];
  for (const [index, content] of contents.entries()) {
    messages.push(await transcript.appendMessage(scope, conversation.id, {
      role: index % 2 === 0 ? MessageRole.user : MessageRole.assistant,
      content,
    }));
  }
  return { conversation, messages };
}

function services() {
  const index = new FakeEpisodeIndex();
  const writer = new IndexedEpisodeWriter(episodeStore, index);
  return { index, writer };
}

const userScope = (scope: ConversationScope) => ({ tenantId: scope.tenantId, userId: scope.userId });

before(async () => { await prisma.$connect(); });
after(async () => { await prisma.$disconnect(); });

describe("Event episodes", () => {
  it("saves durable events as dated episodes, skips trivial and duplicate ones, and still saves facts", async () => {
    const owner = await createOwner();
    const { index, writer } = services();
    const { conversation, messages } = await conversationWith(owner.scope, ["I won a marathon yesterday and I'm vegetarian."]);
    const source = messages[0]!;
    const candidate = (content: string, kind: SemanticFactCandidate["kind"], durability: number, occurredAt: Date | null = null): SemanticFactCandidate => ({
      content, category: SemanticMemoryCategory.profile, kind, durability, occurredAt, sourceMessageId: source.id,
    });
    const marathonDate = new Date("2026-11-24T00:00:00Z");
    const service = new AutomaticSemanticMemoryService(
      { extract: async () => [
        candidate("The user won first prize in a 15km marathon on 2026-11-24.", "event", 0.4, marathonDate),
        candidate("The user had coffee this morning.", "event", 0.05),
        candidate("The user is vegetarian.", "fact", 0.95),
      ] },
      semanticStore,
      undefined,
      undefined,
      { episodes: writer },
    );

    try {
      const first = await service.extractAndSave(userScope(owner.scope), conversation.id, [
        { id: source.id, role: "user", content: source.content },
      ]);
      const second = await service.extractAndSave(userScope(owner.scope), conversation.id, [
        { id: source.id, role: "user", content: source.content },
      ]);

      assert.equal(first.savedEpisodes.length, 1);
      assert.equal(first.savedEpisodes[0]?.type, "event");
      assert.equal(first.savedEpisodes[0]?.occurredAt?.toISOString(), marathonDate.toISOString());
      assert.equal(first.savedEpisodes[0]?.sourceMessageId, source.id);
      assert.deepEqual(first.saved.map(({ content }) => content), ["The user is vegetarian."]);
      assert.deepEqual(first.skipped.map(({ reason }) => reason), ["low_durability"]);
      assert.deepEqual(second.savedEpisodes, []);
      assert.deepEqual(second.skipped.map(({ reason }) => reason), ["duplicate_episode", "low_durability"]);
      assert.equal(index.indexed.length, 1);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });

  it("skips events as not_a_fact when no episode writer is configured", async () => {
    const owner = await createOwner();
    const { conversation, messages } = await conversationWith(owner.scope, ["I won a marathon yesterday."]);
    const service = new AutomaticSemanticMemoryService(
      { extract: async () => [{
        content: "The user won a marathon.", category: SemanticMemoryCategory.profile,
        kind: "event", durability: 0.9, occurredAt: null, sourceMessageId: messages[0]!.id,
      }] },
      semanticStore,
    );
    try {
      const result = await service.extractAndSave(userScope(owner.scope), conversation.id, [
        { id: messages[0]!.id, role: "user", content: messages[0]!.content },
      ]);
      assert.deepEqual(result.skipped.map(({ reason }) => reason), ["not_a_fact"]);
      assert.deepEqual(result.savedEpisodes, []);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
    }
  });
});

describe("Episode retrieval", () => {
  it("adds retrieved episodes with dates to the prompt, separately from facts, and never across users", async () => {
    const owner = await createOwner();
    const stranger = await createOwner();
    const { index, writer } = services();
    const { conversation, messages } = await conversationWith(owner.scope, ["We fixed the AWS deploy on Friday."]);
    const strangerChat = await conversationWith(stranger.scope, ["I fixed my deploy too."]);
    const fixedOn = new Date("2026-11-20T00:00:00Z");
    try {
      await writer.saveEvent(userScope(owner.scope), {
        content: "The user fixed the AWS deploy on 2026-11-20.",
        occurredAt: fixedOn,
        sourceConversationId: conversation.id,
        sourceMessageId: messages[0]!.id,
      });
      await writer.saveEvent(userScope(stranger.scope), {
        content: "The stranger fixed a deploy.",
        occurredAt: null,
        sourceConversationId: strangerChat.conversation.id,
        sourceMessageId: strangerChat.messages[0]!.id,
      });
      const retrieval = new EpisodeRetrievalService(episodeStore, index);
      const current = await transcript.createConversation(owner.scope);
      await transcript.appendMessage(owner.scope, current.id, { role: MessageRole.user, content: "When did we fix the deploy?" });
      const builder = new ConversationPromptBuilder(
        new ConversationContextCompactor(
          transcript,
          new ConversationSummaryService(transcript, { async generate() { throw new Error("no summaries"); } }),
          { inputTokenBudget: 10_000 },
        ),
        { async retrieve() { return []; } },
        {},
        retrieval,
        { limit: 3, scoreThreshold: 0.5 },
      );

      const built = await builder.build(owner.scope, current.id, "System.", "When did we fix the deploy?");
      const date = "2026-11-20";

      assert.equal(built.episodes.length, 1);
      assert.equal(built.episodes[0]?.sourceConversationId, conversation.id);
      assert.match(built.messages[0]?.content ?? "", /episodic memory/i);
      assert.match(built.messages[0]?.content ?? "", new RegExp(`"date": "${date}"`));
      assert.deepEqual(await retrieval.retrieve(userScope(owner.scope), "deploy", { scoreThreshold: 0.95 }), []);
      const ownList = await episodeStore.list(userScope(owner.scope));
      assert.deepEqual(ownList.map(({ sourceConversationId }) => sourceConversationId), [conversation.id]);
    } finally {
      await prisma.tenant.delete({ where: { id: owner.tenantId } });
      await prisma.tenant.delete({ where: { id: stranger.tenantId } });
    }
  });
});
