import { MessageRole } from "./generated/prisma/enums.js";
import type { ConversationScope, EpisodicMemory } from "./episodic-memory.js";
import type {
  CreateEventEpisodeInput,
  EpisodeRecord,
  EpisodeScope,
  EpisodeStore,
} from "./episode-store.js";
import type { EpisodeVectorInput } from "./episode-vector-store.js";
import type { EventEpisodeWriter } from "./semantic-memory-extraction-service.js";

/** Transcript access needed to finish conversations. `EpisodicMemory` is the transcript (ADR 0002). */
type Transcript = Pick<
  EpisodicMemory,
  "getConversation" | "markEnded" | "listUnendedConversations" | "listMessages" | "getLatestSummary"
>;

export interface EpisodeIndexer {
  index(episode: EpisodeVectorInput): Promise<void>;
}

export interface EpisodeSummaryInput {
  /** ISO date the conversation started. */
  startedOn: string;
  /** Compaction summary of earlier messages, when the transcript was compacted. */
  previousSummary?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface EpisodeSummaryGenerator {
  summarize(input: EpisodeSummaryInput): Promise<string>;
}

export type ConversationEndResult =
  | { status: "already_ended"; episode: EpisodeRecord | null }
  | { status: "ended"; episode: EpisodeRecord | null };

export interface FinishPreviousConversationsResult {
  ended: Array<{ conversationId: string; episodeId: string | null }>;
  failed: Array<{ conversationId: string; error: string }>;
}

const PAGE_SIZE = 200;
/** Most recent messages sent to the summarizer; earlier ones are covered by the compaction summary, if any. */
const MAX_SUMMARY_MESSAGES = 200;

/** Saves episodes to PostgreSQL and indexes them for retrieval. */
export class IndexedEpisodeWriter implements EventEpisodeWriter {
  constructor(
    private readonly store: EpisodeStore,
    private readonly indexer: EpisodeIndexer,
  ) {}

  async saveEvent(scope: EpisodeScope, input: CreateEventEpisodeInput): Promise<EpisodeRecord | null> {
    const episode = await this.store.createEvent(scope, input);
    if (episode) await this.indexEpisode(episode);
    return episode;
  }

  async indexEpisode(episode: EpisodeRecord): Promise<void> {
    await this.indexer.index({
      id: episode.id,
      tenantId: episode.tenantId,
      userId: episode.userId,
      content: episode.content,
      type: episode.type,
    });
  }
}

/** Turns finished conversations into dated conversation episodes. */
export class ConversationEpisodeService {
  constructor(
    private readonly transcript: Transcript,
    private readonly store: EpisodeStore,
    private readonly writer: IndexedEpisodeWriter,
    private readonly summarizer: EpisodeSummaryGenerator,
  ) {}

  /**
   * Summarizes the conversation into an episode, then marks it ended. Idempotent. If summarizing
   * fails, the conversation stays unended so a later call can retry.
   */
  async end(scope: ConversationScope, conversationId: string): Promise<ConversationEndResult> {
    const conversation = await this.transcript.getConversation(scope, conversationId);
    if (!conversation) throw new Error("Conversation not found in this scope");
    const episodeScope = { tenantId: scope.tenantId, userId: scope.userId };
    if (conversation.endedAt) {
      return { status: "already_ended", episode: await this.store.getConversationEpisode(episodeScope, conversationId) };
    }

    const messages = await this.loadVisibleMessages(scope, conversationId);
    if (messages.length === 0) {
      await this.transcript.markEnded(scope, conversationId);
      return { status: "ended", episode: null };
    }

    let episode = await this.store.getConversationEpisode(episodeScope, conversationId);
    if (!episode) {
      const summary = await this.transcript.getLatestSummary(scope, conversationId);
      const unsummarized = messages.filter(({ sequenceNo }) => !summary || sequenceNo > summary.throughSequenceNo);
      const content = await this.summarizer.summarize({
        startedOn: conversation.startedAt.toISOString().slice(0, 10),
        ...(summary ? { previousSummary: summary.summaryText } : {}),
        messages: unsummarized.slice(-MAX_SUMMARY_MESSAGES).map(({ role, content }) => ({ role, content })),
      });
      const last = messages.at(-1)!;
      episode = await this.store.createConversationEpisode(episodeScope, {
        content,
        occurredAt: conversation.startedAt,
        endedAt: last.createdAt,
        sourceConversationId: conversationId,
        throughSequenceNo: last.sequenceNo,
      }) ?? await this.store.getConversationEpisode(episodeScope, conversationId);
      if (episode) await this.writer.indexEpisode(episode);
    }

    const ended = await this.transcript.markEnded(scope, conversationId);
    return { status: ended ? "ended" : "already_ended", episode };
  }

  /** Best-effort: ends the user's other unended conversations. Never throws for a single failure. */
  async finishPrevious(
    scope: Pick<ConversationScope, "tenantId" | "userId">,
    excludeConversationId?: string,
  ): Promise<FinishPreviousConversationsResult> {
    const result: FinishPreviousConversationsResult = { ended: [], failed: [] };
    const conversations = await this.transcript.listUnendedConversations(scope, {
      ...(excludeConversationId ? { excludeConversationId } : {}),
    });
    for (const conversation of conversations) {
      try {
        const ended = await this.end(conversation.scope, conversation.id);
        result.ended.push({ conversationId: conversation.id, episodeId: ended.episode?.id ?? null });
      } catch (error) {
        result.failed.push({
          conversationId: conversation.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  private async loadVisibleMessages(scope: ConversationScope, conversationId: string) {
    const visible: Array<{ sequenceNo: number; role: "user" | "assistant"; content: string; createdAt: Date }> = [];
    let afterSequenceNo = 0;
    for (;;) {
      const page = await this.transcript.listMessages(scope, conversationId, { afterSequenceNo, limit: PAGE_SIZE });
      for (const message of page) {
        if (message.role === MessageRole.user || message.role === MessageRole.assistant) {
          visible.push({
            sequenceNo: message.sequenceNo,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
          });
        }
      }
      if (page.length < PAGE_SIZE) return visible;
      afterSequenceNo = page.at(-1)!.sequenceNo;
    }
  }
}
