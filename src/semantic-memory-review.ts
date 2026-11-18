import type { SemanticMemoryScope, SemanticMemoryRecord } from "./semantic-memory.js";
import { SemanticMemoryStore } from "./semantic-memory.js";
import type { ExtractionMessage, SemanticFactCandidate } from "./semantic-fact-extractor.js";

export interface SemanticFactExtractor {
  extract(messages: ExtractionMessage[]): Promise<SemanticFactCandidate[]>;
}

export type SemanticFactReviewer = (
  candidate: SemanticFactCandidate,
  index: number,
  total: number,
) => boolean | Promise<boolean>;

export interface ReviewedSemanticFact {
  candidate: SemanticFactCandidate;
  approved: boolean;
  saved?: SemanticMemoryRecord;
}

export interface SemanticFactReviewResult {
  reviewed: ReviewedSemanticFact[];
  saved: SemanticMemoryRecord[];
}

export class SemanticFactReviewSourceError extends Error {
  constructor(messageId: string) {
    super(`Extracted fact must cite a user message supplied for review: ${messageId}`);
    this.name = "SemanticFactReviewSourceError";
  }
}

/** Runs extraction, requests an explicit decision for each candidate, and saves approved facts. */
export class SemanticFactReviewService {
  constructor(
    private readonly extractor: SemanticFactExtractor,
    private readonly store: SemanticMemoryStore,
  ) {}

  async extractReviewAndSave(
    scope: SemanticMemoryScope,
    sourceConversationId: string,
    messages: ExtractionMessage[],
    reviewer: SemanticFactReviewer,
  ): Promise<SemanticFactReviewResult> {
    const candidates = await this.extractor.extract(messages);
    const userMessageIds = new Set(
      messages.filter((message) => message.role === "user").map((message) => message.id),
    );
    for (const candidate of candidates) {
      if (!userMessageIds.has(candidate.sourceMessageId)) {
        throw new SemanticFactReviewSourceError(candidate.sourceMessageId);
      }
    }

    const reviewed: ReviewedSemanticFact[] = [];
    const saved: SemanticMemoryRecord[] = [];

    for (const [index, candidate] of candidates.entries()) {
      const approved = await reviewer(candidate, index, candidates.length);
      if (!approved) {
        reviewed.push({ candidate, approved: false });
        continue;
      }

      const record = await this.store.create(scope, {
        content: candidate.content,
        category: candidate.category,
        sourceConversationId,
        sourceMessageId: candidate.sourceMessageId,
      });
      saved.push(record);
      reviewed.push({ candidate, approved: true, saved: record });
    }

    return { reviewed, saved };
  }
}
