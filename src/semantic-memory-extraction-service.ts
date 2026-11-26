import { SemanticMemoryCategory, type SemanticMemoryCategory as SemanticMemoryCategoryType } from "./generated/prisma/enums.js";
import type { ExtractionInput, ExtractionMessage, SemanticFactCandidate } from "./semantic-fact-extractor.js";
import type { SemanticMemoryScope, SemanticMemoryRecord } from "./semantic-memory.js";
import type { CreateEventEpisodeInput, EpisodeRecord } from "./episode-store.js";
import { SemanticMemoryStore } from "./semantic-memory.js";
import { GroqSemanticFactComparator, type SemanticFactComparator } from "./semantic-fact-comparator.js";
import type {
  SemanticMemoryVectorInput,
  SemanticMemoryVectorScope,
  SimilarSemanticMemoryId,
} from "./semantic-memory-vector-store.js";

export interface SemanticFactExtractor {
  extract(input: ExtractionInput): Promise<SemanticFactCandidate[]>;
}

export interface SemanticMemoryIndexer {
  index(memory: SemanticMemoryVectorInput): Promise<void>;
  updateStatus(memoryId: string, status: "active" | "superseded"): Promise<void>;
  findSimilar(
    scope: SemanticMemoryVectorScope,
    queryText: string,
    options?: { limit?: number; scoreThreshold?: number },
  ): Promise<SimilarSemanticMemoryId[]>;
}

export type SkippedSemanticFactReason =
  | "unsupported_source"
  | "confirmation_only"
  | "invalid_candidate"
  | "duplicate_in_batch"
  | "same_as_existing"
  | "uncertain_comparison"
  | "not_a_fact"
  | "low_durability"
  | "duplicate_episode";

export interface SkippedSemanticFact {
  candidate: SemanticFactCandidate;
  reason: SkippedSemanticFactReason;
}

/** Saves event episodes (and indexes them); returns null for a duplicate. */
export interface EventEpisodeWriter {
  saveEvent(scope: SemanticMemoryScope, input: CreateEventEpisodeInput): Promise<EpisodeRecord | null>;
}

export interface AutomaticSemanticMemoryResult {
  extracted: SemanticFactCandidate[];
  saved: SemanticMemoryRecord[];
  /** Event episodes saved from this turn. */
  savedEpisodes: EpisodeRecord[];
  skipped: SkippedSemanticFact[];
  supersededMemoryIds: string[];
}

const CATEGORIES = Object.values(SemanticMemoryCategory);
/** Earlier messages given to the extractor only to resolve references in the newest user message. */
export const EXTRACTION_CONTEXT_LIMIT = 4;
export const DEFAULT_DURABILITY_THRESHOLD = 0.7;
export const DEFAULT_EVENT_DURABILITY_THRESHOLD = 0.3;

export interface AutomaticSemanticMemoryOptions {
  /** Minimum durability (0–1) for a fact candidate to be saved. Defaults to 0.7. */
  durabilityThreshold?: number;
  /** Where kind=event candidates go. Without it, events are skipped as not_a_fact. */
  episodes?: EventEpisodeWriter;
  /** Minimum durability (0–1) for an event to become an episode. Defaults to 0.3. */
  eventDurabilityThreshold?: number;
  /** Clock used to give the extractor the current date. */
  now?: () => Date;
}
const CONFIRMATION_ONLY_PATTERN = /^(?:the\s+)?user\s+(?:agrees?|agreed|confirms?|confirmed|says?\s+yes|said\s+yes)\b/i;

/**
 * Extracts candidates from the newest user message, keeps only durable facts, and saves them.
 * The last supplied message is the extraction target; up to EXTRACTION_CONTEXT_LIMIT earlier
 * messages are reference-only context.
 */
export class AutomaticSemanticMemoryService {
  private readonly comparator?: SemanticFactComparator;
  private readonly durabilityThreshold: number;
  private readonly eventDurabilityThreshold: number;
  private readonly episodes?: EventEpisodeWriter;
  private readonly now: () => Date;

  constructor(
    private readonly extractor: SemanticFactExtractor,
    private readonly store: SemanticMemoryStore,
    private readonly vectorStore?: SemanticMemoryIndexer,
    comparator?: SemanticFactComparator,
    options: AutomaticSemanticMemoryOptions = {},
  ) {
    this.comparator = comparator ?? (vectorStore ? new GroqSemanticFactComparator() : undefined);
    this.durabilityThreshold = validThreshold(
      options.durabilityThreshold ?? DEFAULT_DURABILITY_THRESHOLD,
      "durabilityThreshold",
    );
    this.eventDurabilityThreshold = validThreshold(
      options.eventDurabilityThreshold ?? DEFAULT_EVENT_DURABILITY_THRESHOLD,
      "eventDurabilityThreshold",
    );
    if (options.episodes) this.episodes = options.episodes;
    this.now = options.now ?? (() => new Date());
  }

  async extractAndSave(
    scope: SemanticMemoryScope,
    sourceConversationId: string,
    messages: ExtractionMessage[],
  ): Promise<AutomaticSemanticMemoryResult> {
    const target = messages.at(-1);
    if (!target || target.role !== "user") {
      throw new Error("The last extraction message must be the newest user message");
    }
    const context = messages.slice(0, -1).slice(-EXTRACTION_CONTEXT_LIMIT);
    const extracted = await this.extractor.extract({ context, target, currentDate: this.now() });
    const saved: SemanticMemoryRecord[] = [];
    const savedEpisodes: EpisodeRecord[] = [];
    const skipped: SkippedSemanticFact[] = [];
    const supersededMemoryIds: string[] = [];
    const seenFacts = new Set<string>();

    for (const candidate of extracted) {
      if (candidate.sourceMessageId !== target.id) {
        skipped.push({ candidate, reason: "unsupported_source" });
        continue;
      }
      if (!candidate.content.trim() || !CATEGORIES.includes(candidate.category as SemanticMemoryCategoryType)) {
        skipped.push({ candidate, reason: "invalid_candidate" });
        continue;
      }
      if (candidate.kind === "event" && this.episodes) {
        if (!candidate.content.trim()) {
          skipped.push({ candidate, reason: "invalid_candidate" });
        } else if (!(candidate.durability >= this.eventDurabilityThreshold)) {
          skipped.push({ candidate, reason: "low_durability" });
        } else {
          const episode = await this.episodes.saveEvent(scope, {
            content: candidate.content,
            occurredAt: candidate.occurredAt,
            sourceConversationId,
            sourceMessageId: candidate.sourceMessageId,
          });
          if (episode) savedEpisodes.push(episode);
          else skipped.push({ candidate, reason: "duplicate_episode" });
        }
        continue;
      }
      if (candidate.kind !== "fact") {
        skipped.push({ candidate, reason: "not_a_fact" });
        continue;
      }
      if (!(candidate.durability >= this.durabilityThreshold)) {
        skipped.push({ candidate, reason: "low_durability" });
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

      let supersedesMemoryId: string | undefined;
      if (this.vectorStore && this.comparator) {
        const similarIds = await this.vectorStore.findSimilar(scope, candidate.content, { limit: 5 });
        const similarFacts = await this.loadActiveSimilarFacts(scope, similarIds);
        if (similarFacts.length > 0) {
          const comparison = await this.comparator.compare(candidate, similarFacts);
          if (comparison.action === "same") {
            skipped.push({ candidate, reason: "same_as_existing" });
            continue;
          }
          if (comparison.action === "uncertain") {
            skipped.push({ candidate, reason: "uncertain_comparison" });
            continue;
          }
          if (comparison.action === "update") supersedesMemoryId = comparison.existingMemoryId;
        }
      }

      const record = await this.store.create(scope, {
        content: candidate.content.trim(),
        category: candidate.category,
        sourceConversationId,
        sourceMessageId: candidate.sourceMessageId,
        ...(supersedesMemoryId ? { supersedesMemoryId } : {}),
      });
      if (this.vectorStore) await this.vectorStore.index(record);
      if (supersedesMemoryId) {
        if (this.vectorStore) await this.vectorStore.updateStatus(supersedesMemoryId, "superseded");
        supersededMemoryIds.push(supersedesMemoryId);
      }
      saved.push(record);
    }

    return { extracted, saved, savedEpisodes, skipped, supersededMemoryIds };
  }

  private async loadActiveSimilarFacts(
    scope: SemanticMemoryScope,
    matches: SimilarSemanticMemoryId[],
  ) {
    const records = await Promise.all(matches.map(({ semanticMemoryId }) =>
      this.store.getById(scope, semanticMemoryId),
    ));
    return records
      .filter((record): record is SemanticMemoryRecord => record !== null && record.status === "active")
      .map(({ id, content, category }) => ({ id, content, category }));
  }
}

function validThreshold(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return value;
}
