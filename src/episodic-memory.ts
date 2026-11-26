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

export interface ConversationOverview {
  id: string;
  title: string | null;
  startedAt: Date;
  /** First user message, or null when the conversation has none. */
  preview: string | null;
  /** Number of user and assistant messages. */
  messageCount: number;
  lastMessageAt: Date | null;
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

  /**
   * Lists the scope's conversations, most recent activity first. `messageCount` and `preview`
   * cover only user/assistant messages; empty conversations sort by their start time.
   */
  async listConversations(scope: ConversationScope): Promise<ConversationOverview[]> {
    this.validateScope(scope);
    const visibleRoles = { role: { in: [MessageRole.user, MessageRole.assistant] } };
    const conversations = await this.prisma.conversation.findMany({
      where: { tenantId: scope.tenantId, userId: scope.userId, sessionId: scope.sessionId },
      select: {
        id: true,
        title: true,
        startedAt: true,
        _count: { select: { messages: { where: visibleRoles } } },
        messages: {
          where: { role: MessageRole.user },
          orderBy: { sequenceNo: "asc" },
          take: 1,
          select: { content: true },
        },
      },
    });
    const lastActivity = await this.prisma.conversationMessage.groupBy({
      by: ["conversationId"],
      where: { tenantId: scope.tenantId, conversationId: { in: conversations.map(({ id }) => id) } },
      _max: { createdAt: true },
    });
    const lastMessageAt = new Map(lastActivity.map((row) => [row.conversationId, row._max.createdAt]));

    return conversations
      .map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        startedAt: conversation.startedAt,
        preview: conversation.messages[0]?.content ?? null,
        messageCount: conversation._count.messages,
        lastMessageAt: lastMessageAt.get(conversation.id) ?? null,
      }))
      .sort((a, b) => (b.lastMessageAt ?? b.startedAt).getTime() - (a.lastMessageAt ?? a.startedAt).getTime());
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

  /** Conversation metadata within the scope, or null. */
  getConversation(scope: ConversationScope, conversationId: string) {
    this.validateScope(scope);
    if (!conversationId.trim()) return Promise.resolve(null);
    return this.prisma.conversation.findFirst({
      where: {
        tenantId: scope.tenantId,
        id: conversationId,
        userId: scope.userId,
        sessionId: scope.sessionId,
      },
      select: { id: true, startedAt: true, endedAt: true, nextSequenceNo: true },
    });
  }

  /** Marks a conversation ended; returns false if it was already ended or is out of scope. */
  async markEnded(scope: ConversationScope, conversationId: string, endedAt = new Date()): Promise<boolean> {
    this.validateScope(scope);
    const result = await this.prisma.conversation.updateMany({
      where: {
        tenantId: scope.tenantId,
        id: conversationId,
        userId: scope.userId,
        sessionId: scope.sessionId,
        endedAt: null,
      },
      data: { endedAt },
    });
    return result.count === 1;
  }

  /** The user's unended conversations across all sessions, oldest first, with their own session scope. */
  async listUnendedConversations(
    scope: Pick<ConversationScope, "tenantId" | "userId">,
    options: { excludeConversationId?: string; limit?: number } = {},
  ): Promise<Array<{ id: string; scope: ConversationScope }>> {
    if (!scope.tenantId.trim() || !scope.userId.trim()) throw new Error("tenantId and userId must not be empty");
    const conversations = await this.prisma.conversation.findMany({
      where: {
        tenantId: scope.tenantId,
        userId: scope.userId,
        endedAt: null,
        ...(options.excludeConversationId ? { id: { not: options.excludeConversationId } } : {}),
      },
      orderBy: { startedAt: "asc" },
      take: options.limit ?? 20,
      select: { id: true, sessionId: true },
    });
    return conversations.map(({ id, sessionId }) => ({
      id,
      scope: { tenantId: scope.tenantId, userId: scope.userId, sessionId },
    }));
  }

  private validateScope(scope: ConversationScope): void {
    for (const [name, value] of Object.entries(scope)) {
      if (!value.trim()) throw new Error(`${name} must not be empty`);
    }
  }
}
