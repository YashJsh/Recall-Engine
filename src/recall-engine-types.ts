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

/** Only "event" episodes are created for now; conversation episodes are planned. */
export type RecallEpisodeType = "event" | "conversation";

/** Episodic memory: a dated record of a past event or conversation, cited to the transcript. */
export interface RecallEpisode {
  id: string;
  type: RecallEpisodeType;
  content: string;
  /** Event date, or the conversation's start time. Null when an event has no clear date. */
  occurredAt: Date | null;
  /** Conversation episodes: time of the last summarized message. */
  endedAt: Date | null;
  sourceConversationId: string;
  /** Event episodes: the user message the event came from. */
  sourceMessageId: string | null;
  /** Conversation episodes: last transcript sequence number covered. */
  throughSequenceNo: number | null;
  createdAt: Date;
}

export interface RecallRetrievedEpisode {
  episodeId: string;
  type: RecallEpisodeType;
  content: string;
  occurredAt: Date | null;
  endedAt: Date | null;
  sourceConversationId: string;
  sourceMessageId: string | null;
  score: number;
}

export interface RecallEpisodeRetrievalOptions {
  limit?: number;
  scoreThreshold?: number;
}

export interface RecallConversationOverview extends RecallConversation {
  /** First user message, or null when the conversation has none. */
  preview: string | null;
  /** Number of user and assistant messages. */
  messageCount: number;
  lastMessageAt: Date | null;
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
    episodes: RecallRetrievedEpisode[];
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

export type RecallSemanticFactKind = "fact" | "event" | "task" | "request";

export interface RecallSemanticFactCandidate {
  content: string;
  category: RecallSemanticMemoryCategory;
  /** Only "fact" candidates are saved; events and tasks are dropped until their layers exist. */
  kind: RecallSemanticFactKind;
  /** 0–1: how likely the statement stays true and useful in later conversations. */
  durability: number;
  /** Events only: the date it happened, or null. */
  occurredAt: Date | null;
  sourceMessageId: string;
}

export type RecallSkippedSemanticFactReason =
  | "unsupported_source"
  | "confirmation_only"
  | "invalid_candidate"
  | "duplicate_in_batch"
  | "same_as_existing"
  | "uncertain_comparison"
  | "not_a_fact"
  | "low_durability"
  | "duplicate_episode";

export interface RecallSkippedSemanticFact {
  candidate: RecallSemanticFactCandidate;
  reason: RecallSkippedSemanticFactReason;
}

export interface RecallAutomaticSemanticMemoryResult {
  extracted: RecallSemanticFactCandidate[];
  saved: RecallSemanticMemoryFact[];
  /** Event episodes saved from this turn. */
  savedEpisodes: RecallEpisode[];
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
  /** Max facts recalled into each turn's prompt. Defaults to RECALL_SEMANTIC_MEMORY_TOP_K or 5. */
  semanticMemoryTopK?: number;
  /**
   * Minimum relevance score (cosine similarity, 0–1) for a fact to enter the prompt.
   * Defaults to RECALL_SEMANTIC_MEMORY_SCORE_THRESHOLD or 0.5.
   */
  semanticMemoryScoreThreshold?: number;
  /**
   * Minimum durability (0–1) for an extracted fact to be saved.
   * Defaults to RECALL_SEMANTIC_MEMORY_DURABILITY_THRESHOLD or 0.7.
   */
  semanticMemoryDurabilityThreshold?: number;
  /** Qdrant collection for episodes. Defaults to QDRANT_EPISODE_COLLECTION or episodes. */
  qdrantEpisodeCollection?: string;
  /**
   * Minimum durability (0–1) for an extracted event to be saved as an episode.
   * Defaults to RECALL_EPISODIC_MEMORY_EVENT_DURABILITY_THRESHOLD or 0.3.
   */
  episodicMemoryEventDurabilityThreshold?: number;
  /** Max episodes recalled into each turn's prompt. Defaults to RECALL_EPISODIC_MEMORY_TOP_K or 3. */
  episodicMemoryTopK?: number;
  /**
   * Minimum relevance score (0–1) for an episode to enter the prompt.
   * Defaults to RECALL_EPISODIC_MEMORY_SCORE_THRESHOLD or 0.6.
   */
  episodicMemoryScoreThreshold?: number;
}

export interface RecallSemanticMemoryRetrievalOptions {
  limit?: number;
  scoreThreshold?: number;
}

export interface RecallEngine {
  conversations: {
    create(scope: RecallMemoryScope, title?: string): Promise<RecallConversation>;
    /** The scope's conversations, most recent activity first. */
    list(scope: RecallMemoryScope): Promise<RecallConversationOverview[]>;
    prepareTurn(input: PrepareTurnInput): Promise<RecallPreparedTurn>;
    completeTurn(input: CompleteTurnInput): Promise<RecallCompletedTurn>;
    listMessages(
      scope: RecallMemoryScope,
      conversationId: string,
      options?: RecallListMessagesOptions,
    ): Promise<RecallConversationMessage[]>;
    /** One message by ID, or null when it is missing or outside the scope and conversation. */
    getMessage(
      scope: RecallMemoryScope,
      conversationId: string,
      messageId: string,
    ): Promise<RecallConversationMessage | null>;
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
  episodicMemory: {
    retrieve(
      scope: RecallSemanticMemoryScope,
      queryText: string,
      options?: RecallEpisodeRetrievalOptions,
    ): Promise<RecallRetrievedEpisode[]>;
    /** The user's episodes, most recent first. */
    list(scope: RecallSemanticMemoryScope, options?: { limit?: number }): Promise<RecallEpisode[]>;
  };
  close(): Promise<void>;
}
