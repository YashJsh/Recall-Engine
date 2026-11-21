export type RecallMessageRole = "system" | "user" | "assistant" | "tool";
export type RecallSemanticMemoryCategory = "preference" | "profile" | "project_fact";
export type RecallSemanticMemoryStatus = "active" | "superseded";
export type RecallPromptRole = RecallMessageRole;

export interface RecallPromptMessage {
  role: RecallPromptRole;
  content: string;
}

export interface RecallMemoryScope {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface RecallSemanticMemoryScope {
  tenantId: string;
  userId: string;
}

export interface RecallConversation {
  id: string;
  title: string | null;
  startedAt: Date;
}

export interface RecallConversationMessage {
  id: string;
  tenantId: string;
  conversationId: string;
  sequenceNo: number;
  role: RecallMessageRole;
  content: string;
  createdAt: Date;
}

export interface RecallConversationSummary {
  id: string;
  conversationId: string;
  version: number;
  summaryText: string;
  throughSequenceNo: number;
  createdAt: Date;
}

export interface RecallListMessagesOptions {
  afterSequenceNo?: number;
  throughSequenceNo?: number;
  limit?: number;
}

export interface RecallWorkingMemoryItem {
  id: string;
  content: string;
  tokenCount: number;
  priority: number;
  protected?: boolean;
}

export interface RecallWorkingMemoryOptions {
  tokenBudget: number;
  sessionTtlMs: number;
  keyPrefix?: string;
}

export interface RecallContextCompactionResult {
  messages: RecallPromptMessage[];
  tokenCount: number;
  inputTokenBudget: number;
  compactionPerformed: boolean;
  targetReached: boolean;
  summaryBatches: number;
  summaryVersion?: number;
  summaryThroughSequenceNo?: number;
}

export interface RecallPreparedTurn {
  conversationId: string;
  userMessage: Pick<RecallConversationMessage, "id" | "sequenceNo" | "role" | "content">;
  prompt: RecallContextCompactionResult & {
    semanticMemories: RecallRetrievedSemanticMemory[];
  };
}

export type RecallSemanticMemoryOutcome =
  | { status: "success"; result: RecallAutomaticSemanticMemoryResult }
  | { status: "failed"; error: string };

export interface RecallCompletedTurn {
  assistantMessage: RecallConversationMessage;
  semanticMemory: RecallSemanticMemoryOutcome;
}

export interface RecallSemanticMemoryFact {
  id: string;
  content: string;
  category: RecallSemanticMemoryCategory;
  status: RecallSemanticMemoryStatus;
  sourceConversationId: string;
  sourceMessageId: string;
  supersedesMemoryId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecallSemanticMemoryFactInput {
  content: string;
  category: RecallSemanticMemoryCategory;
  sourceConversationId: string;
  sourceMessageId: string;
  supersedesMemoryId?: string;
}

export interface RecallRetrievedSemanticMemory {
  semanticMemoryId: string;
  content: string;
  category: RecallSemanticMemoryCategory;
  sourceConversationId: string;
  sourceMessageId: string;
  score: number;
}

export interface RecallSemanticFactCandidate {
  content: string;
  category: RecallSemanticMemoryCategory;
  sourceMessageId: string;
}

export type RecallSkippedSemanticFactReason =
  | "unsupported_source"
  | "confirmation_only"
  | "invalid_candidate"
  | "duplicate_in_batch"
  | "same_as_existing"
  | "uncertain_comparison";

export interface RecallSkippedSemanticFact {
  candidate: RecallSemanticFactCandidate;
  reason: RecallSkippedSemanticFactReason;
}

export interface RecallAutomaticSemanticMemoryResult {
  extracted: RecallSemanticFactCandidate[];
  saved: RecallSemanticMemoryFact[];
  skipped: RecallSkippedSemanticFact[];
  supersededMemoryIds: string[];
}

export interface PrepareTurnInput {
  scope: RecallMemoryScope;
  conversationId: string;
  systemPrompt: string;
  userMessage: string;
  /** Retry prompt preparation using the ID from ConversationPromptPreparationError. */
  resumeUserMessageId?: string;
}

export interface CompleteTurnInput {
  scope: RecallMemoryScope;
  preparedTurn: RecallPreparedTurn;
  assistantContent: string;
}

export interface RecallEngineOptions {
  /** PostgreSQL connection string. Defaults to DATABASE_URL. */
  databaseUrl?: string;
  /** Redis connection string. Defaults to REDIS_URL or the local Redis address. */
  redisUrl?: string;
  /** Qdrant address. Defaults to QDRANT_URL or the local Qdrant address. */
  qdrantUrl?: string;
  /** Qdrant collection. Defaults to QDRANT_COLLECTION or semantic_memories. */
  qdrantCollection?: string;
  /** Input context budget for conversation compaction. Defaults to RECALL_CONTEXT_INPUT_TOKEN_BUDGET or 12000. */
  contextInputTokenBudget?: number;
  /** Working-memory token budget. Defaults to RECALL_WORKING_MEMORY_TOKEN_BUDGET or 4000. */
  workingMemoryTokenBudget?: number;
  /** Working-memory session TTL. Defaults to RECALL_WORKING_MEMORY_SESSION_TTL_MS or 1800000. */
  workingMemorySessionTtlMs?: number;
}

export interface RecallSemanticMemoryRetrievalOptions {
  limit?: number;
  scoreThreshold?: number;
}

export interface RecallEngine {
  conversations: {
    create(scope: RecallMemoryScope, title?: string): Promise<RecallConversation>;
    prepareTurn(input: PrepareTurnInput): Promise<RecallPreparedTurn>;
    completeTurn(input: CompleteTurnInput): Promise<RecallCompletedTurn>;
    listMessages(
      scope: RecallMemoryScope,
      conversationId: string,
      options?: RecallListMessagesOptions,
    ): Promise<RecallConversationMessage[]>;
    getLatestSummary(
      scope: RecallMemoryScope,
      conversationId: string,
    ): Promise<RecallConversationSummary | null>;
    listSummaryVersions(
      scope: RecallMemoryScope,
      conversationId: string,
    ): Promise<RecallConversationSummary[]>;
  };
  workingMemory: {
    addItem(scope: RecallMemoryScope, item: RecallWorkingMemoryItem): Promise<{
      accepted: boolean;
      evicted: string[];
      tokenUsage: number;
    }>;
    getItems(scope: RecallMemoryScope): Promise<RecallWorkingMemoryItem[]>;
    getTokenUsage(scope: RecallMemoryScope): Promise<number>;
    clearSession(scope: RecallMemoryScope): Promise<void>;
  };
  semanticMemory: {
    retrieve(
      scope: RecallSemanticMemoryScope,
      queryText: string,
      options?: RecallSemanticMemoryRetrievalOptions,
    ): Promise<RecallRetrievedSemanticMemory[]>;
    getById(scope: RecallSemanticMemoryScope, memoryId: string): Promise<RecallSemanticMemoryFact | null>;
    saveFact(
      input: RecallSemanticMemoryFactInput & { scope: RecallSemanticMemoryScope },
    ): Promise<RecallSemanticMemoryFact>;
    extractAndSave(
      scope: RecallSemanticMemoryScope,
      sourceConversationId: string,
      messages: Array<{ id: string; role: "user" | "assistant"; content: string }>,
    ): Promise<RecallAutomaticSemanticMemoryResult>;
  };
  close(): Promise<void>;
}
