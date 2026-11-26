import type {
  ContextCompactionResult,
  ConversationContextCompactor,
} from "./context-compaction.js";
import type { ConversationScope } from "./episodic-memory.js";
import {
  formatSemanticMemoryPromptContext,
  type RetrievedSemanticMemory,
  type SemanticMemoryRetrievalOptions,
} from "./semantic-memory-retrieval.js";
import type { SemanticMemoryScope } from "./semantic-memory.js";
import {
  formatEpisodePromptContext,
  type EpisodeRetrievalOptions,
  type RetrievedEpisode,
} from "./episode-retrieval.js";

export interface EpisodeRetriever {
  retrieve(
    scope: SemanticMemoryScope,
    queryText: string,
    options?: EpisodeRetrievalOptions,
  ): Promise<RetrievedEpisode[]>;
}

export interface SemanticMemoryRetriever {
  retrieve(
    scope: SemanticMemoryScope,
    queryText: string,
    options?: SemanticMemoryRetrievalOptions,
  ): Promise<RetrievedSemanticMemory[]>;
}

export interface ConversationPromptBuildResult extends ContextCompactionResult {
  semanticMemories: RetrievedSemanticMemory[];
  /** Episodic memory retrieved for this turn; empty when no episode retriever is configured. */
  episodes: RetrievedEpisode[];
}

/** Combines verified semantic memories with the bounded conversation prompt for a model caller. */
export class ConversationPromptBuilder {
  constructor(
    private readonly contextCompactor: ConversationContextCompactor,
    private readonly semanticMemoryRetriever: SemanticMemoryRetriever,
    /** Top-N limit and minimum relevance score for facts added to the prompt. */
    private readonly retrievalOptions: SemanticMemoryRetrievalOptions = {},
    private readonly episodeRetriever?: EpisodeRetriever,
    /** Top-N limit and minimum relevance score for episodes added to the prompt. */
    private readonly episodeRetrievalOptions: EpisodeRetrievalOptions = {},
  ) {}

  async build(
    scope: ConversationScope,
    conversationId: string,
    systemPrompt: string,
    currentUserMessage: string,
  ): Promise<ConversationPromptBuildResult> {
    if (!currentUserMessage.trim()) throw new Error("currentUserMessage must not be empty");

    const memoryScope: SemanticMemoryScope = {
      tenantId: scope.tenantId,
      userId: scope.userId,
    };
    const [semanticMemories, episodes] = await Promise.all([
      this.semanticMemoryRetriever.retrieve(memoryScope, currentUserMessage, this.retrievalOptions),
      this.episodeRetriever
        ? this.episodeRetriever.retrieve(memoryScope, currentUserMessage, this.episodeRetrievalOptions)
        : Promise.resolve([]),
    ]);
    const augmentedSystemPrompt = [
      systemPrompt,
      formatSemanticMemoryPromptContext(semanticMemories),
      formatEpisodePromptContext(episodes),
    ].filter(Boolean).join("\n\n");
    const compacted = await this.contextCompactor.build(scope, conversationId, augmentedSystemPrompt);

    return { ...compacted, semanticMemories, episodes };
  }
}
