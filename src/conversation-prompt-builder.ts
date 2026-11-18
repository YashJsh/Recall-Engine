import type {
  ContextCompactionResult,
  ConversationContextCompactor,
} from "./context-compaction.js";
import type { ConversationScope } from "./episodic-memory.js";
import {
  formatSemanticMemoryPromptContext,
  type RetrievedSemanticMemory,
} from "./semantic-memory-retrieval.js";
import type { SemanticMemoryScope } from "./semantic-memory.js";

export interface SemanticMemoryRetriever {
  retrieve(scope: SemanticMemoryScope, queryText: string): Promise<RetrievedSemanticMemory[]>;
}

export interface ConversationPromptBuildResult extends ContextCompactionResult {
  semanticMemories: RetrievedSemanticMemory[];
}

/** Combines verified semantic memories with the bounded conversation prompt for a model caller. */
export class ConversationPromptBuilder {
  constructor(
    private readonly contextCompactor: ConversationContextCompactor,
    private readonly semanticMemoryRetriever: SemanticMemoryRetriever,
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
    const semanticMemories = await this.semanticMemoryRetriever.retrieve(memoryScope, currentUserMessage);
    const memoryContext = formatSemanticMemoryPromptContext(semanticMemories);
    const augmentedSystemPrompt = memoryContext
      ? `${systemPrompt}\n\n${memoryContext}`
      : systemPrompt;
    const compacted = await this.contextCompactor.build(scope, conversationId, augmentedSystemPrompt);

    return { ...compacted, semanticMemories };
  }
}
