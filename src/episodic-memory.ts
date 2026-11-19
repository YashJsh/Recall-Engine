import type { PrismaClient } from "./generated/prisma/client.js";
import { MessageRole, type MessageRole as MessageRoleType } from "./generated/prisma/enums.js";

export interface ConversationScope {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface AppendMessageInput {
  role: MessageRoleType;
  content: string;
}

export interface ListMessagesOptions {
  afterSequenceNo?: number;
  throughSequenceNo?: number;
  limit?: number;
}

export interface SaveSummaryInput {
  summaryText: string;
  throughSequenceNo: number;
}

export class SummaryCheckpointError extends Error {
  constructor() {
    super("The conversation summary checkpoint is stale or beyond the available messages");
    this.name = "SummaryCheckpointError";
  }
}

export class ConversationTurnOrderError extends Error {
  constructor() {
    super("The conversation has advanced since this user turn was prepared");
    this.name = "ConversationTurnOrderError";
  }
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

  appendAssistantReplyAfter(
    scope: ConversationScope,
    conversationId: string,
    previousSequenceNo: number,
    content: string,
  ) {
    this.validateScope(scope);
    if (!Number.isInteger(previousSequenceNo) || previousSequenceNo < 1) {
      throw new Error("previousSequenceNo must be a positive integer");
    }
    if (!content.trim()) throw new Error("message.content must not be empty");

    return this.prisma.$transaction(async (transaction) => {
      const advanced = await transaction.conversation.updateMany({
        where: {
          tenantId: scope.tenantId,
          id: conversationId,
          userId: scope.userId,
          sessionId: scope.sessionId,
          nextSequenceNo: previousSequenceNo,
        },
        data: { nextSequenceNo: { increment: 1 } },
      });
      if (advanced.count !== 1) throw new ConversationTurnOrderError();

      return transaction.conversationMessage.create({
        data: {
          tenantId: scope.tenantId,
          conversationId,
          sequenceNo: previousSequenceNo + 1,
          role: MessageRole.assistant,
          content,
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
    if (options.throughSequenceNo !== undefined
      && (!Number.isInteger(options.throughSequenceNo) || options.throughSequenceNo < 1)) {
      throw new Error("throughSequenceNo must be a positive integer");
    }

    const sequenceNo: { gt?: number; lte?: number } = {};
    if (options.afterSequenceNo !== undefined) sequenceNo.gt = options.afterSequenceNo;
    if (options.throughSequenceNo !== undefined) sequenceNo.lte = options.throughSequenceNo;

    return this.prisma.conversationMessage.findMany({
      where: {
        tenantId: scope.tenantId,
        conversationId,
        ...(Object.keys(sequenceNo).length > 0 ? { sequenceNo } : {}),
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

  getMessageById(scope: ConversationScope, conversationId: string, messageId: string) {
    this.validateScope(scope);
    if (!conversationId.trim() || !messageId.trim()) return Promise.resolve(null);

    return this.prisma.conversationMessage.findFirst({
      where: {
        id: messageId,
        tenantId: scope.tenantId,
        conversationId,
        conversation: {
          is: {
            tenantId: scope.tenantId,
            userId: scope.userId,
            sessionId: scope.sessionId,
          },
        },
      },
    });
  }

  saveSummary(
    scope: ConversationScope,
    conversationId: string,
    input: SaveSummaryInput,
  ) {
    this.validateScope(scope);
    if (!input.summaryText.trim()) throw new Error("summaryText must not be empty");
    if (!Number.isInteger(input.throughSequenceNo) || input.throughSequenceNo < 1) {
      throw new Error("throughSequenceNo must be a positive integer");
    }

    return this.prisma.$transaction(async (transaction) => {
      const advanced = await transaction.conversation.updateMany({
        where: {
          tenantId: scope.tenantId,
          id: conversationId,
          userId: scope.userId,
          sessionId: scope.sessionId,
          nextSequenceNo: { gte: input.throughSequenceNo },
          summaryThroughSequenceNo: { lt: input.throughSequenceNo },
        },
        data: {
          summaryThroughSequenceNo: input.throughSequenceNo,
          nextSummaryVersion: { increment: 1 },
        },
      });
      if (advanced.count !== 1) throw new SummaryCheckpointError();

      const conversation = await transaction.conversation.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: scope.tenantId, id: conversationId } },
        select: { nextSummaryVersion: true },
      });

      return transaction.conversationSummary.create({
        data: {
          tenantId: scope.tenantId,
          conversationId,
          version: conversation.nextSummaryVersion,
          summaryText: input.summaryText,
          throughSequenceNo: input.throughSequenceNo,
        },
      });
    });
  }

  getLatestSummary(scope: ConversationScope, conversationId: string) {
    this.validateScope(scope);
    return this.prisma.conversationSummary.findFirst({
      where: {
        tenantId: scope.tenantId,
        conversationId,
        conversation: {
          is: {
            tenantId: scope.tenantId,
            userId: scope.userId,
            sessionId: scope.sessionId,
          },
        },
      },
      orderBy: { version: "desc" },
    });
  }

  listSummaryVersions(scope: ConversationScope, conversationId: string) {
    this.validateScope(scope);
    return this.prisma.conversationSummary.findMany({
      where: {
        tenantId: scope.tenantId,
        conversationId,
        conversation: {
          is: {
            tenantId: scope.tenantId,
            userId: scope.userId,
            sessionId: scope.sessionId,
          },
        },
      },
      orderBy: { version: "asc" },
    });
  }

  private validateScope(scope: ConversationScope): void {
    for (const [name, value] of Object.entries(scope)) {
      if (!value.trim()) throw new Error(`${name} must not be empty`);
    }
  }
}
