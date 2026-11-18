import { SemanticMemoryCategory, type SemanticMemoryCategory as SemanticMemoryCategoryType } from "./generated/prisma/enums.js";
import type { ExtractionMessage, SemanticFactCandidate } from "./semantic-fact-extractor.js";
import type { SemanticMemoryScope, SemanticMemoryRecord } from "./semantic-memory.js";
import { SemanticMemoryStore } from "./semantic-memory.js";
import type { SemanticMemoryVectorInput } from "./semantic-memory-vector-store.js";

export interface SemanticFactExtractor {
  extract(messages: ExtractionMessage[]): Promise<SemanticFactCandidate[]>;
}

export interface SemanticMemoryIndexer {
  index(memory: SemanticMemoryVectorInput): Promise<void>;
}

export type SkippedSemanticFactReason =
  | "unsupported_source"
  | "confirmation_only"
  | "invalid_candidate"
  | "duplicate_in_batch";

export interface SkippedSemanticFact {
  candidate: SemanticFactCandidate;
  reason: SkippedSemanticFactReason;
}

export interface AutomaticSemanticMemoryResult {
  extracted: SemanticFactCandidate[];
  saved: SemanticMemoryRecord[];
  skipped: SkippedSemanticFact[];
}

const CATEGORIES = Object.values(SemanticMemoryCategory);
const CONFIRMATION_ONLY_PATTERN = /^(?:the\s+)?user\s+(?:agrees?|agreed|confirms?|confirmed|says?\s+yes|said\s+yes)\b/i;

/** Extracts candidate facts, applies basic quality/provenance checks, and saves suitable facts. */
export class AutomaticSemanticMemoryService {
  constructor(
    private readonly extractor: SemanticFactExtractor,
    private readonly store: SemanticMemoryStore,
    private readonly vectorStore?: SemanticMemoryIndexer,
  ) {}

  async extractAndSave(
    scope: SemanticMemoryScope,
    sourceConversationId: string,
    messages: ExtractionMessage[],
  ): Promise<AutomaticSemanticMemoryResult> {
    const extracted = await this.extractor.extract(messages);
    const userMessageIds = new Set(
      messages.filter((message) => message.role === "user").map((message) => message.id),
    );
    const saved: SemanticMemoryRecord[] = [];
    const skipped: SkippedSemanticFact[] = [];
    const seenFacts = new Set<string>();

    for (const candidate of extracted) {
      if (!userMessageIds.has(candidate.sourceMessageId)) {
        skipped.push({ candidate, reason: "unsupported_source" });
        continue;
      }
      if (!candidate.content.trim() || !CATEGORIES.includes(candidate.category as SemanticMemoryCategoryType)) {
        skipped.push({ candidate, reason: "invalid_candidate" });
        continue;
      }
      if (CONFIRMATION_ONLY_PATTERN.test(candidate.content.trim())) {
        skipped.push({ candidate, reason: "confirmation_only" });
        continue;
      }

      const dedupeKey = candidate.content.trim().replace(/\s+/g, " ").toLocaleLowerCase();
      if (seenFacts.has(dedupeKey)) {
        skipped.push({ candidate, reason: "duplicate_in_batch" });
        continue;
      }
      seenFacts.add(dedupeKey);

      const record = await this.store.create(scope, {
        content: candidate.content.trim(),
        category: candidate.category,
        sourceConversationId,
        sourceMessageId: candidate.sourceMessageId,
      });
      if (this.vectorStore) await this.vectorStore.index(record);
      saved.push(record);
    }

    return { extracted, saved, skipped };
  }
}
