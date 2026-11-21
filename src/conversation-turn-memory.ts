import { MessageRole } from "./generated/prisma/enums.js";
import type { ConversationPromptBuildResult, ConversationPromptBuilder } from "./conversation-prompt-builder.js";
import {
  ConversationTurnOrderError,
  type ConversationScope,
  type EpisodicMemory,
} from "./episodic-memory.js";
import type { AutomaticSemanticMemoryResult } from "./semantic-memory-extraction-service.js";
import type { ExtractionMessage } from "./semantic-fact-extractor.js";
import type { SemanticMemoryScope } from "./semantic-memory.js";

export { ConversationTurnOrderError };

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

export class ConversationPromptPreparationError extends Error {
  constructor(
    readonly persistedUserMessageId: string,
    readonly persistedUserMessageSequenceNo: number,
    options?: ErrorOptions,
  ) {
    super(
      "The user message was saved, but prompt preparation failed; retry with its persisted message ID to avoid duplicating it",
      options,
    );
    this.name = "ConversationPromptPreparationError";
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
    resumeUserMessageId?: string,
  ): Promise<PreparedConversationTurn> {
    if (!systemPrompt.trim()) throw new Error("systemPrompt must not be empty");
    if (!userContent.trim()) throw new Error("userContent must not be empty");

    let userMessage: PersistedMessage;
    if (resumeUserMessageId !== undefined) {
      if (!resumeUserMessageId.trim()) throw new PreparedConversationTurnError();
      const persisted = await this.episodicMemory.getMessageById(scope, conversationId, resumeUserMessageId);
      if (!persisted
        || persisted.role !== MessageRole.user
        || persisted.content !== userContent) {
        throw new PreparedConversationTurnError();
      }
      await this.assertNoLaterMessages(scope, conversationId, persisted.sequenceNo);
      userMessage = persisted;
    } else {
      userMessage = await this.episodicMemory.appendMessage(scope, conversationId, {
        role: MessageRole.user,
        content: userContent,
      });
    }

    let prompt: ConversationPromptBuildResult;
    try {
      prompt = await this.promptBuilder.build(scope, conversationId, systemPrompt, userMessage.content);
    } catch (error) {
      throw new ConversationPromptPreparationError(userMessage.id, userMessage.sequenceNo, { cause: error });
    }
    if (resumeUserMessageId !== undefined) {
      await this.assertNoLaterMessages(scope, conversationId, userMessage.sequenceNo);
    }

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

    const assistantMessage = await this.episodicMemory.appendAssistantReplyAfter(
      scope,
      preparedTurn.conversationId,
      persistedUserMessage.sequenceNo,
      assistantContent,
    );

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

  private async assertNoLaterMessages(
    scope: ConversationScope,
    conversationId: string,
    sequenceNo: number,
  ): Promise<void> {
    const laterMessages = await this.episodicMemory.listMessages(scope, conversationId, {
      afterSequenceNo: sequenceNo,
      limit: 1,
    });
    if (laterMessages.length > 0) throw new ConversationTurnOrderError();
  }
}
