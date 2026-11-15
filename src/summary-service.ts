import {
  EpisodicMemory,
  SummaryCheckpointError,
  type ConversationScope,
} from "./episodic-memory.js";

export interface SummaryMessage {
  sequenceNo: number;
  role: string;
  content: string;
}

export interface SummaryGenerationInput {
  previousSummary?: string;
  messages: SummaryMessage[];
}

export interface SummaryGenerator {
  generate(input: SummaryGenerationInput): Promise<string>;
}

export interface SummaryServiceOptions {
  maxMessagesPerSummary?: number;
}

export class SummaryInputTooLargeError extends Error {
  constructor(maxMessages: number) {
    super(`Summary input exceeds the limit of ${maxMessages} new messages`);
    this.name = "SummaryInputTooLargeError";
  }
}

const DEFAULT_MAX_MESSAGES = 100;
const MAX_ALLOWED_MESSAGES = 199;

/** Selects the unsummarized message range, calls a provider, then saves a checkpoint. */
export class ConversationSummaryService {
  readonly maxMessagesPerSummary: number;

  constructor(
    private readonly memory: EpisodicMemory,
    private readonly generator: SummaryGenerator,
    options: SummaryServiceOptions = {},
  ) {
    this.maxMessagesPerSummary = options.maxMessagesPerSummary ?? DEFAULT_MAX_MESSAGES;
    if (!Number.isInteger(this.maxMessagesPerSummary)
      || this.maxMessagesPerSummary < 1
      || this.maxMessagesPerSummary > MAX_ALLOWED_MESSAGES) {
      throw new Error(`maxMessagesPerSummary must be between 1 and ${MAX_ALLOWED_MESSAGES}`);
    }
  }

  async summarizeThrough(
    scope: ConversationScope,
    conversationId: string,
    throughSequenceNo: number,
  ) {
    if (!Number.isInteger(throughSequenceNo) || throughSequenceNo < 1) {
      throw new Error("throughSequenceNo must be a positive integer");
    }

    const previous = await this.memory.getLatestSummary(scope, conversationId);
    const lastSummarizedSequence = previous?.throughSequenceNo ?? 0;
    if (throughSequenceNo <= lastSummarizedSequence) throw new SummaryCheckpointError();

    const messages = await this.memory.listMessages(scope, conversationId, {
      afterSequenceNo: lastSummarizedSequence,
      throughSequenceNo,
      limit: this.maxMessagesPerSummary + 1,
    });
    if (messages.length > this.maxMessagesPerSummary) {
      throw new SummaryInputTooLargeError(this.maxMessagesPerSummary);
    }
    if (messages.length === 0 || messages[messages.length - 1].sequenceNo !== throughSequenceNo) {
      throw new SummaryCheckpointError();
    }

    const summaryText = await this.generator.generate({
      previousSummary: previous?.summaryText,
      messages: messages.map(({ sequenceNo, role, content }) => ({
        sequenceNo,
        role,
        content,
      })),
    });
    if (!summaryText.trim()) throw new Error("Summary generator returned empty text");

    return this.memory.saveSummary(scope, conversationId, {
      summaryText,
      throughSequenceNo,
    });
  }
}
