import type { PrismaClient } from "./generated/prisma/client.js";
import type { MessageRole } from "./generated/prisma/enums.js";

export interface ConversationScope {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface AppendMessageInput {
  role: MessageRole;
  content: string;
}

export interface ListMessagesOptions {
  afterSequenceNo?: number;
  limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Durable conversation and exact-message history, scoped to one tenant/user/session. */
export class EpisodicMemory {
  constructor(private readonly prisma: PrismaClient) {}

  createConversation(scope: ConversationScope, title?: string) {
    this.validateScope(scope);
    return this.prisma.conversation.create({
      data: { ...scope, title },
      select: { id: true, title: true, startedAt: true },
    });
  }

  appendMessage(
    scope: ConversationScope,
    conversationId: string,
    message: AppendMessageInput,
  ) {
    this.validateScope(scope);
    if (!message.content) throw new Error("message.content must not be empty");

    return this.prisma.$transaction(async (transaction) => {
      const conversation = await transaction.conversation.update({
        where: {
          tenantId_id: { tenantId: scope.tenantId, id: conversationId },
          userId: scope.userId,
          sessionId: scope.sessionId,
        },
        data: { nextSequenceNo: { increment: 1 } },
        select: { nextSequenceNo: true },
      });

      return transaction.conversationMessage.create({
        data: {
          tenantId: scope.tenantId,
          conversationId,
          sequenceNo: conversation.nextSequenceNo,
          role: message.role,
          content: message.content,
        },
      });
    });
  }

  listMessages(
    scope: ConversationScope,
    conversationId: string,
    options: ListMessagesOptions = {},
  ) {
    this.validateScope(scope);
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new Error(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }
    if (options.afterSequenceNo !== undefined
      && (!Number.isInteger(options.afterSequenceNo) || options.afterSequenceNo < 0)) {
      throw new Error("afterSequenceNo must be a non-negative integer");
    }

    return this.prisma.conversationMessage.findMany({
      where: {
        tenantId: scope.tenantId,
        conversationId,
        ...(options.afterSequenceNo === undefined
          ? {}
          : { sequenceNo: { gt: options.afterSequenceNo } }),
        conversation: {
          is: {
            tenantId: scope.tenantId,
            userId: scope.userId,
            sessionId: scope.sessionId,
          },
        },
      },
      orderBy: { sequenceNo: "asc" },
      take: limit,
    });
  }

  private validateScope(scope: ConversationScope): void {
    for (const [name, value] of Object.entries(scope)) {
      if (!value.trim()) throw new Error(`${name} must not be empty`);
    }
  }
}
