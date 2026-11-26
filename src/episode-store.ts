import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { EpisodeType, MessageRole } from "./generated/prisma/enums.js";
import type { SemanticMemoryScope } from "./semantic-memory.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Episodes belong to a user across sessions, like semantic facts. */
export type EpisodeScope = SemanticMemoryScope;

export type EpisodeRecord = Prisma.EpisodeGetPayload<object>;

export interface CreateEventEpisodeInput {
  content: string;
  occurredAt: Date | null;
  sourceConversationId: string;
  sourceMessageId: string;
}

export class EpisodeSourceError extends Error {
  constructor() {
    super("The episode source does not belong to this tenant, user, and conversation");
    this.name = "EpisodeSourceError";
  }
}

/** Persists episodic memory with a verifiable reference to its transcript source. */
export class EpisodeStore {
  constructor(private readonly prisma: PrismaClient) {}

  /** Returns null when the same event from the same conversation was already saved. */
  async createEvent(scope: EpisodeScope, input: CreateEventEpisodeInput): Promise<EpisodeRecord | null> {
    this.validateScope(scope);
    if (!input.content.trim()) throw new Error("content must not be empty");
    if (!UUID_PATTERN.test(input.sourceConversationId) || !UUID_PATTERN.test(input.sourceMessageId)) {
      throw new EpisodeSourceError();
    }

    const source = await this.prisma.conversationMessage.findFirst({
      where: {
        tenantId: scope.tenantId,
        conversationId: input.sourceConversationId,
        id: input.sourceMessageId,
        role: MessageRole.user,
        conversation: { is: { tenantId: scope.tenantId, userId: scope.userId } },
      },
      select: { id: true },
    });
    if (!source) throw new EpisodeSourceError();

    return this.createUnlessDuplicate({
      tenantId: scope.tenantId,
      userId: scope.userId,
      type: EpisodeType.event,
      content: input.content.trim(),
      occurredAt: input.occurredAt,
      sourceConversationId: input.sourceConversationId,
      sourceMessageId: input.sourceMessageId,
      dedupeKey: dedupeKey(input.content),
    });
  }

  getById(scope: EpisodeScope, episodeId: string): Promise<EpisodeRecord | null> {
    this.validateScope(scope);
    if (!UUID_PATTERN.test(episodeId)) return Promise.resolve(null);
    return this.prisma.episode.findFirst({
      where: { id: episodeId, tenantId: scope.tenantId, userId: scope.userId },
    });
  }

  /** Newest first. */
  list(scope: EpisodeScope, options: { limit?: number } = {}): Promise<EpisodeRecord[]> {
    this.validateScope(scope);
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new Error(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
    }
    return this.prisma.episode.findMany({
      where: { tenantId: scope.tenantId, userId: scope.userId },
      orderBy: [{ occurredAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: limit,
    });
  }

  private async createUnlessDuplicate(data: Prisma.EpisodeUncheckedCreateInput): Promise<EpisodeRecord | null> {
    try {
      return await this.prisma.episode.create({ data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
      throw error;
    }
  }

  private validateScope(scope: EpisodeScope): void {
    if (!UUID_PATTERN.test(scope.tenantId)) throw new Error("tenantId must be a UUID");
    if (!UUID_PATTERN.test(scope.userId)) throw new Error("userId must be a UUID");
  }
}

function dedupeKey(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
