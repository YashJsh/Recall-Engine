import { MessageRole } from "./generated/prisma/enums.js";
import type { ConversationPromptBuildResult, ConversationPromptBuilder } from "./conversation-prompt-builder.js";
import type { ConversationScope, EpisodicMemory } from "./episodic-memory.js";
import type { AutomaticSemanticMemoryResult } from "./semantic-memory-extraction-service.js";
import type { ExtractionMessage } from "./semantic-fact-extractor.js";
import type { SemanticMemoryScope } from "./semantic-memory.js";

const EXTRACTION_CONTEXT_LIMIT = 8;

type PersistedMessage = NonNullable<
  Awaited<ReturnType<EpisodicMemory["getMessageById"]>>
>;

export interface PreparedConversationTurn {
  conversationId: string;
  userMessage: Pick<PersistedMessage, "id" | "sequenceNo" | "role" | "content">;
  prompt: ConversationPromptBuildResult;
}

export type SemanticMemoryTurnOutcome =
  | { status: "success"; result: AutomaticSemanticMemoryResult }
  | { status: "failed"; error: string };

export interface CompletedConversationTurn {
  assistantMessage: PersistedMessage;
  semanticMemory: SemanticMemoryTurnOutcome;
}

export class PreparedConversationTurnError extends Error {
  constructor() {
    super("The prepared user message is missing, modified, or outside the supplied conversation scope");
    this.name = "PreparedConversationTurnError";
  }
}

export interface SemanticMemoryTurnExtractor {
  extractAndSave(
    scope: SemanticMemoryScope,
    sourceConversationId: string,
    messages: ExtractionMessage[],
  ): Promise<AutomaticSemanticMemoryResult>;
}

/** Memory-side turn lifecycle; the consuming application calls its own chat model between these methods. */
export class ConversationTurnMemoryService {
  constructor(
    private readonly episodicMemory: EpisodicMemory,
    private readonly promptBuilder: ConversationPromptBuilder,
    private readonly semanticMemoryExtractor: SemanticMemoryTurnExtractor,
  ) {}

  async prepareTurn(
    scope: ConversationScope,
    conversationId: string,
    systemPrompt: string,
    userContent: string,
  ): Promise<PreparedConversationTurn> {
    if (!systemPrompt.trim()) throw new Error("systemPrompt must not be empty");
    if (!userContent.trim()) throw new Error("userContent must not be empty");

    const userMessage = await this.episodicMemory.appendMessage(scope, conversationId, {
      role: MessageRole.user,
      content: userContent,
    });
    const prompt = await this.promptBuilder.build(scope, conversationId, systemPrompt, userMessage.content);

    return {
      conversationId,
      userMessage: {
        id: userMessage.id,
        sequenceNo: userMessage.sequenceNo,
        role: userMessage.role,
        content: userMessage.content,
      },
      prompt,
    };
  }

  async completeTurn(
    scope: ConversationScope,
    preparedTurn: PreparedConversationTurn,
    assistantContent: string,
  ): Promise<CompletedConversationTurn> {
    if (!assistantContent.trim()) throw new Error("assistantContent must not be empty");

    const persistedUserMessage = await this.episodicMemory.getMessageById(
      scope,
      preparedTurn.conversationId,
      preparedTurn.userMessage.id,
    );
    if (!persistedUserMessage
      || persistedUserMessage.role !== MessageRole.user
      || persistedUserMessage.sequenceNo !== preparedTurn.userMessage.sequenceNo
      || persistedUserMessage.content !== preparedTurn.userMessage.content) {
      throw new PreparedConversationTurnError();
    }

    const assistantMessage = await this.episodicMemory.appendMessage(scope, preparedTurn.conversationId, {
      role: MessageRole.assistant,
      content: assistantContent,
    });

    let semanticMemory: SemanticMemoryTurnOutcome;
    try {
      const messages = await this.loadExtractionContext(scope, preparedTurn.conversationId, persistedUserMessage);
      const extractionScope: SemanticMemoryScope = {
        tenantId: scope.tenantId,
        userId: scope.userId,
      };
      const result = await this.semanticMemoryExtractor.extractAndSave(
        extractionScope,
        preparedTurn.conversationId,
        messages,
      );
      semanticMemory = { status: "success", result };
    } catch (error) {
      semanticMemory = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return { assistantMessage, semanticMemory };
  }

  private async loadExtractionContext(
    scope: ConversationScope,
    conversationId: string,
    userMessage: PersistedMessage,
  ): Promise<ExtractionMessage[]> {
    const messages = await this.episodicMemory.listMessages(scope, conversationId, {
      afterSequenceNo: Math.max(0, userMessage.sequenceNo - EXTRACTION_CONTEXT_LIMIT),
      throughSequenceNo: userMessage.sequenceNo,
      limit: EXTRACTION_CONTEXT_LIMIT,
    });
    const extractionMessages = messages.flatMap((message): ExtractionMessage[] => {
      if (message.role !== MessageRole.user && message.role !== MessageRole.assistant) return [];
      return [{ id: message.id, role: message.role, content: message.content }];
    });
    if (!extractionMessages.some(({ id }) => id === userMessage.id)) {
      throw new PreparedConversationTurnError();
    }
    return extractionMessages;
  }
}
