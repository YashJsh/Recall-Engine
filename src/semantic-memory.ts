import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import {
  SemanticMemoryStatus,
  type SemanticMemoryCategory,
} from "./generated/prisma/enums.js";

const semanticMemoryInclude = {
  sourceMessage: { include: { conversation: true } },
} satisfies Prisma.SemanticMemoryInclude;

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
    if (!input.sourceConversationId.trim()) throw new Error("sourceConversationId must not be empty");
    if (!input.sourceMessageId.trim()) throw new Error("sourceMessageId must not be empty");

    return this.prisma.$transaction(async (transaction) => {
      const source = await transaction.conversationMessage.findFirst({
        where: {
          tenantId: scope.tenantId,
          conversationId: input.sourceConversationId,
          id: input.sourceMessageId,
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
    if (!memoryId.trim()) throw new Error("memoryId must not be empty");

    return this.prisma.semanticMemory.findFirst({
      where: { id: memoryId, tenantId: scope.tenantId, userId: scope.userId },
      include: semanticMemoryInclude,
    });
  }

  private validateScope(scope: SemanticMemoryScope): void {
    if (!scope.tenantId.trim()) throw new Error("tenantId must not be empty");
    if (!scope.userId.trim()) throw new Error("userId must not be empty");
  }
}
