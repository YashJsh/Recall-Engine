import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import {
  MessageRole,
  SemanticMemoryStatus,
  type SemanticMemoryCategory,
} from "./generated/prisma/enums.js";

const semanticMemoryInclude = {
  sourceMessage: { include: { conversation: true } },
} satisfies Prisma.SemanticMemoryInclude;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SemanticMemoryScope = {
  tenantId: string;
  userId: string;
};

export interface CreateSemanticMemoryInput {
  content: string;
  category: SemanticMemoryCategory;
  sourceConversationId: string;
  sourceMessageId: string;
  supersedesMemoryId?: string;
}

export type SemanticMemoryRecord = Prisma.SemanticMemoryGetPayload<{
  include: typeof semanticMemoryInclude;
}>;

export class SemanticMemorySourceError extends Error {
  constructor() {
    super("The source message does not belong to this tenant, user, and conversation");
    this.name = "SemanticMemorySourceError";
  }
}

export class SemanticMemorySupersessionError extends Error {
  constructor() {
    super("The fact to supersede is missing, out of scope, or already superseded");
    this.name = "SemanticMemorySupersessionError";
  }
}

/** Persists user-scoped facts with a verifiable reference to their source message. */
export class SemanticMemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    scope: SemanticMemoryScope,
    input: CreateSemanticMemoryInput,
  ): Promise<SemanticMemoryRecord> {
    this.validateScope(scope);
    if (!input.content.trim()) throw new Error("content must not be empty");
    if (!UUID_PATTERN.test(input.sourceConversationId) || !UUID_PATTERN.test(input.sourceMessageId)) {
      throw new SemanticMemorySourceError();
    }
    if (input.supersedesMemoryId !== undefined && !UUID_PATTERN.test(input.supersedesMemoryId)) {
      throw new SemanticMemorySupersessionError();
    }

    return this.prisma.$transaction(async (transaction) => {
      const source = await transaction.conversationMessage.findFirst({
        where: {
          tenantId: scope.tenantId,
          conversationId: input.sourceConversationId,
          id: input.sourceMessageId,
          role: MessageRole.user,
          conversation: {
            is: { tenantId: scope.tenantId, userId: scope.userId },
          },
        },
        select: { id: true },
      });
      if (!source) throw new SemanticMemorySourceError();

      if (input.supersedesMemoryId !== undefined) {
        const superseded = await transaction.semanticMemory.updateMany({
          where: {
            id: input.supersedesMemoryId,
            tenantId: scope.tenantId,
            userId: scope.userId,
            status: SemanticMemoryStatus.active,
          },
          data: { status: SemanticMemoryStatus.superseded },
        });
        if (superseded.count !== 1) throw new SemanticMemorySupersessionError();
      }

      return transaction.semanticMemory.create({
        data: {
          tenantId: scope.tenantId,
          userId: scope.userId,
          content: input.content,
          category: input.category,
          sourceConversationId: input.sourceConversationId,
          sourceMessageId: input.sourceMessageId,
          supersedesMemoryId: input.supersedesMemoryId,
        },
        include: semanticMemoryInclude,
      });
    });
  }

  getById(
    scope: SemanticMemoryScope,
    memoryId: string,
  ): Promise<SemanticMemoryRecord | null> {
    this.validateScope(scope);
    if (!UUID_PATTERN.test(memoryId)) return Promise.resolve(null);

    return this.prisma.semanticMemory.findFirst({
      where: { id: memoryId, tenantId: scope.tenantId, userId: scope.userId },
      include: semanticMemoryInclude,
    });
  }

  private validateScope(scope: SemanticMemoryScope): void {
    if (!UUID_PATTERN.test(scope.tenantId)) throw new Error("tenantId must be a UUID");
    if (!UUID_PATTERN.test(scope.userId)) throw new Error("userId must be a UUID");
  }
}
