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
  type ListMessagesOptions,
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
import { RedisWorkingMemory, type WorkingMemoryItem, type WorkingMemoryOptions } from "./working-memory.js";
import type {
  RecallContextCompactionResult,
  RecallAutomaticSemanticMemoryResult,
  RecallCompletedTurn,
  RecallConversation,
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
    const vectorStore = new SemanticMemoryVectorStore({
      ...(options.qdrantUrl ? { url: options.qdrantUrl } : {}),
      ...(options.qdrantCollection ? { collectionName: options.qdrantCollection } : {}),
    });
    await vectorStore.checkConnection();

    const automaticMemory = new LazyAutomaticSemanticMemoryService(semanticStore, vectorStore);
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
    const promptBuilder = new ConversationPromptBuilder(compactor, retrieval);
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
  close: () => Promise<void>;
}

function createPublicEngine(dependencies: EngineDependencies): RecallEngine {
  let closePromise: Promise<void> | undefined;

  return {
    conversations: {
      async create(scope, title): Promise<RecallConversation> {
        return dependencies.episodicMemory.createConversation(scope, title);
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
          input.preparedTurn as PreparedConversationTurn,
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
          options as ListMessagesOptions | undefined,
        )).map(toPublicMessage);
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
        return dependencies.workingMemory.addItem(scope, item as WorkingMemoryItem);
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

class LazyAutomaticSemanticMemoryService implements SemanticMemoryTurnExtractor {
  private service?: AutomaticSemanticMemoryService;

  constructor(
    private readonly store: SemanticMemoryStore,
    private readonly vectorStore: SemanticMemoryVectorStore,
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
    );
    return this.service.extractAndSave(scope, sourceConversationId, messages);
  }
}

function readOptions(options: RecallEngineOptions): {
  contextInputTokenBudget: number;
  workingMemory: WorkingMemoryOptions;
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
  };
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
    skipped: result.skipped,
    supersededMemoryIds: result.supersededMemoryIds,
  };
}
