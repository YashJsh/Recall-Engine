import "dotenv/config";
import { ConversationPromptBuilder } from "./conversation-prompt-builder.js";
import {
  ConversationContextCompactor,
  type ContextCompactionResult,
} from "./context-compaction.js";
import {
  ConversationTurnMemoryService,
  type PreparedConversationTurn,
  type SemanticMemoryTurnExtractor,
} from "./conversation-turn-memory.js";
import {
  EpisodicMemory,
  type ConversationScope,
} from "./episodic-memory.js";
import { createPostgresClient } from "./postgres-client.js";
import { connectRedis } from "./redis-client.js";
import {
  AutomaticSemanticMemoryService,
  type AutomaticSemanticMemoryResult,
} from "./semantic-memory-extraction-service.js";
import { GroqSemanticFactExtractor } from "./semantic-fact-extractor.js";
import { SemanticMemoryRetrievalService } from "./semantic-memory-retrieval.js";
import { SemanticMemoryStore, type SemanticMemoryRecord } from "./semantic-memory.js";
import { SemanticMemoryVectorStore } from "./semantic-memory-vector-store.js";
import { ConversationSummaryService, type SummaryGenerationInput, type SummaryGenerator } from "./summary-service.js";
import { GroqSummaryGenerator } from "./providers/groq-summary-generator.js";
import { RedisWorkingMemory, type WorkingMemoryOptions } from "./working-memory.js";
import { EpisodeStore, type EpisodeRecord } from "./episode-store.js";
import { EpisodeVectorStore } from "./episode-vector-store.js";
import { EpisodeRetrievalService } from "./episode-retrieval.js";
import {
  ConversationEpisodeService,
  IndexedEpisodeWriter,
  type EpisodeSummaryGenerator,
  type EpisodeSummaryInput,
} from "./episodic-memory-service.js";
import { GroqEpisodeSummarizer } from "./providers/groq-episode-summarizer.js";
import { FastEmbedTextEmbedder } from "./semantic-memory-vector-store.js";
import type {
  RecallContextCompactionResult,
  RecallAutomaticSemanticMemoryResult,
  RecallCompletedTurn,
  RecallConversationEndResult,
  RecallCreatedConversation,
  RecallEpisode,
  RecallRetrievedEpisode,
  RecallConversationOverview,
  RecallConversationMessage,
  RecallConversationSummary,
  RecallEngine,
  RecallEngineOptions,
  RecallListMessagesOptions,
  RecallMemoryScope,
  RecallPreparedTurn,
  RecallRetrievedSemanticMemory,
  RecallSemanticMemoryFact,
  RecallSemanticMemoryFactInput,
  RecallSemanticMemoryScope,
  RecallWorkingMemoryItem,
} from "./recall-engine-types.js";

const DEFAULT_CONTEXT_INPUT_TOKEN_BUDGET = 12_000;
const DEFAULT_WORKING_MEMORY_TOKEN_BUDGET = 4_000;
const DEFAULT_WORKING_MEMORY_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SEMANTIC_MEMORY_TOP_K = 5;
const DEFAULT_SEMANTIC_MEMORY_SCORE_THRESHOLD = 0.5;
const DEFAULT_SEMANTIC_MEMORY_DURABILITY_THRESHOLD = 0.7;
const DEFAULT_EPISODIC_MEMORY_EVENT_DURABILITY_THRESHOLD = 0.3;
const DEFAULT_EPISODIC_MEMORY_TOP_K = 3;
const DEFAULT_EPISODIC_MEMORY_SCORE_THRESHOLD = 0.5;
const CLIENT_NAME = "recall-engine";

export class RecallEngineConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecallEngineConnectionError";
  }
}

/** Connects all memory stores and returns the supported consumer-facing API. */
export async function connectRecallEngine(options: RecallEngineOptions = {}): Promise<RecallEngine> {
  const config = readOptions(options);
  const prisma = createPostgresClient(options.databaseUrl, CLIENT_NAME);
  let redis: Awaited<ReturnType<typeof connectRedis>> | undefined;

  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    redis = await connectRedis(options.redisUrl, CLIENT_NAME);

    const episodicMemory = new EpisodicMemory(prisma);
    const semanticStore = new SemanticMemoryStore(prisma);
    const embedder = new FastEmbedTextEmbedder();
    const vectorStore = new SemanticMemoryVectorStore({
      ...(options.qdrantUrl ? { url: options.qdrantUrl } : {}),
      ...(options.qdrantCollection ? { collectionName: options.qdrantCollection } : {}),
      embedder,
    });
    await vectorStore.checkConnection();
    const episodeStore = new EpisodeStore(prisma);
    const episodeVectorStore = new EpisodeVectorStore({
      ...(options.qdrantUrl ? { url: options.qdrantUrl } : {}),
      ...(options.qdrantEpisodeCollection ? { collectionName: options.qdrantEpisodeCollection } : {}),
      embedder,
    });
    const episodeWriter = new IndexedEpisodeWriter(episodeStore, episodeVectorStore);
    const episodeRetrieval = new EpisodeRetrievalService(episodeStore, episodeVectorStore);
    const conversationEpisodes = new ConversationEpisodeService(
      episodicMemory,
      episodeStore,
      episodeWriter,
      new LazyEpisodeSummarizer(),
    );

    const automaticMemory = new LazyAutomaticSemanticMemoryService(
      semanticStore,
      vectorStore,
      config.semanticDurabilityThreshold,
      episodeWriter,
      config.eventDurabilityThreshold,
    );
    const retrieval = new SemanticMemoryRetrievalService(semanticStore, vectorStore);
    const summaryService = new ConversationSummaryService(
      episodicMemory,
      new LazySummaryGenerator(),
    );
    const compactor = new ConversationContextCompactor(
      episodicMemory,
      summaryService,
      { inputTokenBudget: config.contextInputTokenBudget },
    );
    const promptBuilder = new ConversationPromptBuilder(
      compactor,
      retrieval,
      config.semanticRetrieval,
      episodeRetrieval,
      config.episodeRetrieval,
    );
    const turnService = new ConversationTurnMemoryService(episodicMemory, promptBuilder, automaticMemory);
    const workingMemory = new RedisWorkingMemory(redis, config.workingMemory);

    return createPublicEngine({
      episodicMemory,
      turnService,
      workingMemory,
      semanticStore,
      retrieval,
      vectorStore,
      automaticMemory,
      episodeStore,
      episodeRetrieval,
      conversationEpisodes,
      close: () => closeClients(prisma, redis),
    });
  } catch (error) {
    await closeClients(prisma, redis).catch(() => undefined);
    throw new RecallEngineConnectionError(
      "Unable to connect Recall Engine to PostgreSQL, Redis, or Qdrant",
      { cause: error },
    );
  }
}

interface EngineDependencies {
  episodicMemory: EpisodicMemory;
  turnService: ConversationTurnMemoryService;
  workingMemory: RedisWorkingMemory;
  semanticStore: SemanticMemoryStore;
  retrieval: SemanticMemoryRetrievalService;
  vectorStore: SemanticMemoryVectorStore;
  automaticMemory: LazyAutomaticSemanticMemoryService;
  episodeStore: EpisodeStore;
  episodeRetrieval: EpisodeRetrievalService;
  conversationEpisodes: ConversationEpisodeService;
  close: () => Promise<void>;
}

function createPublicEngine(dependencies: EngineDependencies): RecallEngine {
  let closePromise: Promise<void> | undefined;

  return {
    conversations: {
      async create(scope, title): Promise<RecallCreatedConversation> {
        const finishedConversations = await dependencies.conversationEpisodes
          .finishPrevious({ tenantId: scope.tenantId, userId: scope.userId })
          .catch((error: unknown) => ({
            ended: [],
            failed: [{ conversationId: "*", error: error instanceof Error ? error.message : String(error) }],
          }));
        const conversation = await dependencies.episodicMemory.createConversation(scope, title);
        return { ...conversation, finishedConversations };
      },
      async end(scope, conversationId): Promise<RecallConversationEndResult> {
        const result = await dependencies.conversationEpisodes.end(scope, conversationId);
        return { status: result.status, episode: result.episode ? toPublicEpisode(result.episode) : null };
      },
      async list(scope): Promise<RecallConversationOverview[]> {
        return dependencies.episodicMemory.listConversations(scope);
      },
      async prepareTurn(input): Promise<RecallPreparedTurn> {
        const prepared = await dependencies.turnService.prepareTurn(
          input.scope,
          input.conversationId,
          input.systemPrompt,
          input.userMessage,
          input.resumeUserMessageId,
        );
        return toPublicPreparedTurn(prepared);
      },
      async completeTurn(input): Promise<RecallCompletedTurn> {
        const result = await dependencies.turnService.completeTurn(
          input.scope,
          input.preparedTurn,
          input.assistantContent,
        );
        return {
          assistantMessage: toPublicMessage(result.assistantMessage),
          semanticMemory: result.semanticMemory.status === "failed"
            ? result.semanticMemory
            : {
                status: "success",
                result: toPublicAutomaticResult(result.semanticMemory.result),
              },
        };
      },
      async listMessages(scope, conversationId, options): Promise<RecallConversationMessage[]> {
        return (await dependencies.episodicMemory.listMessages(
          scope,
          conversationId,
          options,
        )).map(toPublicMessage);
      },
      async getMessage(scope, conversationId, messageId): Promise<RecallConversationMessage | null> {
        const message = await dependencies.episodicMemory.getMessageById(scope, conversationId, messageId);
        return message ? toPublicMessage(message) : null;
      },
      async getLatestSummary(scope, conversationId): Promise<RecallConversationSummary | null> {
        const summary = await dependencies.episodicMemory.getLatestSummary(scope, conversationId);
        return summary ? toPublicSummary(summary) : null;
      },
      async listSummaryVersions(scope, conversationId): Promise<RecallConversationSummary[]> {
        return (await dependencies.episodicMemory.listSummaryVersions(scope, conversationId)).map(toPublicSummary);
      },
    },
    workingMemory: {
      addItem(scope: RecallMemoryScope, item: RecallWorkingMemoryItem) {
        return dependencies.workingMemory.addItem(scope, item);
      },
      getItems(scope: RecallMemoryScope) {
        return dependencies.workingMemory.getItems(scope);
      },
      getTokenUsage(scope: RecallMemoryScope) {
        return dependencies.workingMemory.getTokenUsage(scope);
      },
      clearSession(scope: RecallMemoryScope) {
        return dependencies.workingMemory.clearSession(scope);
      },
    },
    semanticMemory: {
      async retrieve(scope: RecallSemanticMemoryScope, queryText: string, options): Promise<RecallRetrievedSemanticMemory[]> {
        return dependencies.retrieval.retrieve(scope, queryText, options);
      },
      async getById(scope: RecallSemanticMemoryScope, memoryId: string): Promise<RecallSemanticMemoryFact | null> {
        const fact = await dependencies.semanticStore.getById(scope, memoryId);
        return fact ? toPublicFact(fact) : null;
      },
      async saveFact(
        input: RecallSemanticMemoryFactInput & { scope: RecallSemanticMemoryScope },
      ): Promise<RecallSemanticMemoryFact> {
        const { scope, ...factInput } = input;
        const fact = await dependencies.semanticStore.create(scope, factInput);
        await dependencies.vectorStore.index(fact);
        if (factInput.supersedesMemoryId) {
          await dependencies.vectorStore.updateStatus(factInput.supersedesMemoryId, "superseded");
        }
        return toPublicFact(fact);
      },
      async extractAndSave(scope, sourceConversationId, messages): Promise<RecallAutomaticSemanticMemoryResult> {
        return toPublicAutomaticResult(
          await dependencies.automaticMemory.extractAndSave(scope, sourceConversationId, messages),
        );
      },
    },
    episodicMemory: {
      async retrieve(scope, queryText, options): Promise<RecallRetrievedEpisode[]> {
        return dependencies.episodeRetrieval.retrieve(scope, queryText, options);
      },
      async list(scope, options): Promise<RecallEpisode[]> {
        return (await dependencies.episodeStore.list(scope, options)).map(toPublicEpisode);
      },
    },
    close() {
      closePromise ??= dependencies.close();
      return closePromise;
    },
  };
}

class LazySummaryGenerator implements SummaryGenerator {
  private generator?: GroqSummaryGenerator;

  generate(input: SummaryGenerationInput): Promise<string> {
    this.generator ??= new GroqSummaryGenerator();
    return this.generator.generate(input);
  }
}

class LazyEpisodeSummarizer implements EpisodeSummaryGenerator {
  private summarizer?: GroqEpisodeSummarizer;

  summarize(input: EpisodeSummaryInput): Promise<string> {
    this.summarizer ??= new GroqEpisodeSummarizer();
    return this.summarizer.summarize(input);
  }
}

class LazyAutomaticSemanticMemoryService implements SemanticMemoryTurnExtractor {
  private service?: AutomaticSemanticMemoryService;

  constructor(
    private readonly store: SemanticMemoryStore,
    private readonly vectorStore: SemanticMemoryVectorStore,
    private readonly durabilityThreshold: number,
    private readonly episodeWriter: IndexedEpisodeWriter,
    private readonly eventDurabilityThreshold: number,
  ) {}

  extractAndSave(
    scope: RecallSemanticMemoryScope,
    sourceConversationId: string,
    messages: Parameters<SemanticMemoryTurnExtractor["extractAndSave"]>[2],
  ): Promise<AutomaticSemanticMemoryResult> {
    this.service ??= new AutomaticSemanticMemoryService(
      new GroqSemanticFactExtractor(),
      this.store,
      this.vectorStore,
      undefined,
      {
        durabilityThreshold: this.durabilityThreshold,
        episodes: this.episodeWriter,
        eventDurabilityThreshold: this.eventDurabilityThreshold,
      },
    );
    return this.service.extractAndSave(scope, sourceConversationId, messages);
  }
}

function readOptions(options: RecallEngineOptions): {
  contextInputTokenBudget: number;
  workingMemory: WorkingMemoryOptions;
  semanticRetrieval: { limit: number; scoreThreshold: number };
  semanticDurabilityThreshold: number;
  eventDurabilityThreshold: number;
  episodeRetrieval: { limit: number; scoreThreshold: number };
} {
  return {
    contextInputTokenBudget: positiveIntegerOption(
      options.contextInputTokenBudget,
      "RECALL_CONTEXT_INPUT_TOKEN_BUDGET",
      DEFAULT_CONTEXT_INPUT_TOKEN_BUDGET,
    ),
    workingMemory: {
      tokenBudget: positiveIntegerOption(
        options.workingMemoryTokenBudget,
        "RECALL_WORKING_MEMORY_TOKEN_BUDGET",
        DEFAULT_WORKING_MEMORY_TOKEN_BUDGET,
      ),
      sessionTtlMs: positiveIntegerOption(
        options.workingMemorySessionTtlMs,
        "RECALL_WORKING_MEMORY_SESSION_TTL_MS",
        DEFAULT_WORKING_MEMORY_SESSION_TTL_MS,
      ),
    },
    semanticRetrieval: {
      limit: positiveIntegerOption(
        options.semanticMemoryTopK,
        "RECALL_SEMANTIC_MEMORY_TOP_K",
        DEFAULT_SEMANTIC_MEMORY_TOP_K,
      ),
      scoreThreshold: scoreOption(
        options.semanticMemoryScoreThreshold,
        "RECALL_SEMANTIC_MEMORY_SCORE_THRESHOLD",
        DEFAULT_SEMANTIC_MEMORY_SCORE_THRESHOLD,
      ),
    },
    semanticDurabilityThreshold: scoreOption(
      options.semanticMemoryDurabilityThreshold,
      "RECALL_SEMANTIC_MEMORY_DURABILITY_THRESHOLD",
      DEFAULT_SEMANTIC_MEMORY_DURABILITY_THRESHOLD,
    ),
    eventDurabilityThreshold: scoreOption(
      options.episodicMemoryEventDurabilityThreshold,
      "RECALL_EPISODIC_MEMORY_EVENT_DURABILITY_THRESHOLD",
      DEFAULT_EPISODIC_MEMORY_EVENT_DURABILITY_THRESHOLD,
    ),
    episodeRetrieval: {
      limit: positiveIntegerOption(
        options.episodicMemoryTopK,
        "RECALL_EPISODIC_MEMORY_TOP_K",
        DEFAULT_EPISODIC_MEMORY_TOP_K,
      ),
      scoreThreshold: scoreOption(
        options.episodicMemoryScoreThreshold,
        "RECALL_EPISODIC_MEMORY_SCORE_THRESHOLD",
        DEFAULT_EPISODIC_MEMORY_SCORE_THRESHOLD,
      ),
    },
  };
}

function scoreOption(value: number | undefined, environmentName: string, fallback: number): number {
  const configured = process.env[environmentName];
  const resolved = value ?? (configured === undefined || configured === "" ? fallback : Number(configured));
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new Error(`${environmentName} must be a number between 0 and 1`);
  }
  return resolved;
}

function positiveIntegerOption(value: number | undefined, environmentName: string, fallback: number): number {
  if (value !== undefined) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${environmentName} must be a positive integer`);
    return value;
  }
  const configured = process.env[environmentName];
  if (configured === undefined || configured.trim() === "") return fallback;
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${environmentName} must be a positive integer`);
  return parsed;
}

async function closeClients(
  prisma: ReturnType<typeof createPostgresClient>,
  redis?: Awaited<ReturnType<typeof connectRedis>>,
): Promise<void> {
  const errors: unknown[] = [];
  if (redis) {
    try {
      if (redis.isOpen) await redis.quit();
      else redis.destroy();
    } catch (error) {
      redis.destroy();
      errors.push(error);
    }
  }
  try {
    await prisma.$disconnect();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "Failed to close one or more Recall Engine clients");
}

function toPublicPreparedTurn(prepared: PreparedConversationTurn): RecallPreparedTurn {
  return {
    conversationId: prepared.conversationId,
    userMessage: {
      id: prepared.userMessage.id,
      sequenceNo: prepared.userMessage.sequenceNo,
      role: prepared.userMessage.role,
      content: prepared.userMessage.content,
    },
    prompt: {
      ...toPublicCompactionResult(prepared.prompt),
      semanticMemories: prepared.prompt.semanticMemories,
      episodes: prepared.prompt.episodes,
    },
  };
}

function toPublicCompactionResult(result: ContextCompactionResult): RecallContextCompactionResult {
  return {
    messages: result.messages.map(({ role, content }) => ({ role, content })),
    tokenCount: result.tokenCount,
    inputTokenBudget: result.inputTokenBudget,
    compactionPerformed: result.compactionPerformed,
    targetReached: result.targetReached,
    summaryBatches: result.summaryBatches,
    ...(result.summaryVersion === undefined ? {} : { summaryVersion: result.summaryVersion }),
    ...(result.summaryThroughSequenceNo === undefined
      ? {}
      : { summaryThroughSequenceNo: result.summaryThroughSequenceNo }),
  };
}

function toPublicMessage(message: Awaited<ReturnType<EpisodicMemory["appendMessage"]>>): RecallConversationMessage {
  return {
    id: message.id,
    tenantId: message.tenantId,
    conversationId: message.conversationId,
    sequenceNo: message.sequenceNo,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  };
}

function toPublicSummary(summary: Awaited<ReturnType<EpisodicMemory["getLatestSummary"]>> & {}): RecallConversationSummary {
  return {
    id: summary.id,
    conversationId: summary.conversationId,
    version: summary.version,
    summaryText: summary.summaryText,
    throughSequenceNo: summary.throughSequenceNo,
    createdAt: summary.createdAt,
  };
}

function toPublicFact(fact: SemanticMemoryRecord): RecallSemanticMemoryFact {
  return {
    id: fact.id,
    content: fact.content,
    category: fact.category,
    status: fact.status,
    sourceConversationId: fact.sourceConversationId,
    sourceMessageId: fact.sourceMessageId,
    supersedesMemoryId: fact.supersedesMemoryId,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  };
}

function toPublicAutomaticResult(result: AutomaticSemanticMemoryResult): RecallAutomaticSemanticMemoryResult {
  return {
    extracted: result.extracted,
    saved: result.saved.map(toPublicFact),
    savedEpisodes: result.savedEpisodes.map(toPublicEpisode),
    skipped: result.skipped,
    supersededMemoryIds: result.supersededMemoryIds,
  };
}

function toPublicEpisode(episode: EpisodeRecord): RecallEpisode {
  return {
    id: episode.id,
    type: episode.type,
    content: episode.content,
    occurredAt: episode.occurredAt,
    endedAt: episode.endedAt,
    sourceConversationId: episode.sourceConversationId,
    sourceMessageId: episode.sourceMessageId,
    throughSequenceNo: episode.throughSequenceNo,
    createdAt: episode.createdAt,
  };
}
