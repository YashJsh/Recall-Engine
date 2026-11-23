import { createHash } from "node:crypto";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "groq-sdk/resources/chat/completions";
import type {
  RecallCompletedTurn,
  RecallEngine,
  RecallMemoryScope,
  RecallPromptMessage,
  RecallRetrievedSemanticMemory,
} from "recall-engine";
import {
  AGENT_TOOLS,
  countNoteTokens,
  MAX_NOTE_CHARACTERS,
  MAX_TOOL_CALLS_PER_TURN,
  type AgentToolCall,
  type HostModel,
  workingMemorySystemContext,
} from "./agent.ts";

const BASE_SYSTEM_PROMPT = "You are a helpful assistant in a local memory demonstration. Respond with concise, direct answers.";


export interface ChatHandlerDependencies {
  recall: RecallEngine;
  scope: RecallMemoryScope;
  conversationId: () => string | Promise<string>;
  model: HostModel;
  onSavedFacts?: (ids: string[]) => Promise<void>;
}

export interface ChatHandlerResponse {
  assistantMessage: RecallCompletedTurn["assistantMessage"];
  semanticMemory: RecallCompletedTurn["semanticMemory"];
  retrievedMemories: RecallRetrievedSemanticMemory[];
  latestSummary: Awaited<ReturnType<ChatHandlerDependencies["recall"]["conversations"]["getLatestSummary"]>>;
  promptCalls: Array<{ messages: ChatCompletionMessageParam[] }>;
  toolTrace: Array<{ name: string; status: string; detail: string }>;
  workingMemoryItems: Awaited<ReturnType<ChatHandlerDependencies["recall"]["workingMemory"]["getItems"]>>;
  workingMemoryTokenUsage: number;
}

export function createChatPostHandler(dependencies: ChatHandlerDependencies) {
  return async function handleChat(request: Request): Promise<Response> {
    let userMessage: string;
    let resumeUserMessageId: string | undefined;
    try {
      const body = await request.json() as { userMessage?: unknown; resumeUserMessageId?: unknown };
      if (typeof body.userMessage !== "string" || !body.userMessage.trim()) {
        return json({ error: "Enter a message before sending." }, 400);
      }
      if (body.userMessage.length > 8_000) {
        return json({ error: "Messages must be 8,000 characters or fewer." }, 400);
      }
      userMessage = body.userMessage.trim();
      resumeUserMessageId = typeof body.resumeUserMessageId === "string"
        ? body.resumeUserMessageId
        : undefined;
    } catch {
      return json({ error: "The message request must contain valid JSON." }, 400);
    }

    const conversationId = await dependencies.conversationId();
    const [workingMemoryItems, workingMemoryTokenUsage] = await Promise.all([
      dependencies.recall.workingMemory.getItems(dependencies.scope),
      dependencies.recall.workingMemory.getTokenUsage(dependencies.scope),
    ]);
    let preparedUserMessageId: string | undefined;

    try {
      const prepared = await dependencies.recall.conversations.prepareTurn({
        scope: dependencies.scope,
        conversationId,
        systemPrompt: `${BASE_SYSTEM_PROMPT}\n\n${workingMemorySystemContext(workingMemoryItems)}`,
        userMessage,
        ...(resumeUserMessageId ? { resumeUserMessageId } : {}),
      });
      preparedUserMessageId = prepared.userMessage.id;

      const modelMessages: ChatCompletionMessageParam[] = toModelMessages(prepared.prompt.messages);
      const promptCalls: ChatHandlerResponse["promptCalls"] = [];
      const toolTrace: ChatHandlerResponse["toolTrace"] = [];
      let toolCallCount = 0;
      let assistantContent: string | undefined;

      while (assistantContent === undefined) {
        promptCalls.push({ messages: structuredClone(modelMessages) });
        const result = await dependencies.model.complete({ messages: modelMessages, tools: AGENT_TOOLS });
        const toolCalls = result.toolCalls ?? [];
        if (toolCalls.length === 0) {
          if (!result.content?.trim()) throw new Error("The host model returned neither an answer nor a tool call");
          assistantContent = result.content.trim();
          break;
        }

        if (toolCallCount + toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
          throw new ToolCallLimitError(toolTrace, promptCalls);
        }
        toolCallCount += toolCalls.length;
        modelMessages.push({
          role: "assistant",
          content: result.content,
          tool_calls: toolCalls.map(({ id, name, arguments: args }) => ({
            id,
            type: "function",
            function: { name, arguments: args },
          })),
        });

        for (const toolCall of toolCalls) {
          const toolResult = await executeTool(toolCall, userMessage, dependencies);
          toolTrace.push({ name: toolCall.name, status: toolResult.status, detail: toolResult.detail });
          modelMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult.content });
        }
      }

      const completed = await dependencies.recall.conversations.completeTurn({
        scope: dependencies.scope,
        preparedTurn: prepared,
        assistantContent,
      });
      if (completed.semanticMemory.status === "success" && completed.semanticMemory.result.saved.length > 0) {
        await dependencies.onSavedFacts?.(completed.semanticMemory.result.saved.map(({ id }) => id))
          .catch(() => undefined);
      }

      const sourceMessages = await Promise.all(prepared.prompt.semanticMemories.map(async (memory) => {
        const messages = await dependencies.recall.conversations.listMessages(
          dependencies.scope,
          memory.sourceConversationId,
        );
        return messages.find(({ id }) => id === memory.sourceMessageId) ?? null;
      }));
      const latestSummary = await dependencies.recall.conversations.getLatestSummary(
        dependencies.scope,
        conversationId,
      );
      const currentWorkingMemoryItems = await dependencies.recall.workingMemory.getItems(dependencies.scope);
      const currentWorkingMemoryTokenUsage = await dependencies.recall.workingMemory.getTokenUsage(dependencies.scope);

      return json({
        assistantMessage: completed.assistantMessage,
        semanticMemory: completed.semanticMemory,
        retrievedMemories: prepared.prompt.semanticMemories.map((memory, index) => ({
          ...memory,
          sourceMessage: sourceMessages[index],
        })),
        latestSummary,
        promptCalls,
        toolTrace,
        workingMemoryItems: currentWorkingMemoryItems,
        workingMemoryTokenUsage: currentWorkingMemoryTokenUsage,
      } satisfies ChatHandlerResponse & { retrievedMemories: Array<RecallRetrievedSemanticMemory & { sourceMessage: unknown }> });
    } catch (error) {
      const isToolLimit = error instanceof ToolCallLimitError;
      const toolTrace = isToolLimit ? error.toolTrace : [];
      const promptCalls = isToolLimit ? error.promptCalls : [];
      return json({
        error: error instanceof Error ? error.message : "The agent turn failed.",
        ...(preparedUserMessageId ? { resumeUserMessageId: preparedUserMessageId } : {}),
        promptCalls,
        toolTrace,
      }, 502);
    }
  };
}

class ToolCallLimitError extends Error {
  constructor(
    readonly toolTrace: ChatHandlerResponse["toolTrace"],
    readonly promptCalls: ChatHandlerResponse["promptCalls"],
  ) {
    super("The agent reached the limit of three tool calls without finishing a reply.");
    this.name = "ToolCallLimitError";
  }
}

async function executeTool(
  toolCall: AgentToolCall,
  currentUserMessage: string,
  dependencies: ChatHandlerDependencies,
): Promise<{ status: string; detail: string; content: string }> {
  if (toolCall.name === "save_temporary_note") {
    let parsed: { content?: unknown };
    try {
      parsed = JSON.parse(toolCall.arguments) as { content?: unknown };
    } catch {
      return toolResult("rejected", "The note arguments were not valid JSON.");
    }
    if (typeof parsed.content !== "string" || !parsed.content.trim()) {
      return toolResult("rejected", "A non-empty note is required.");
    }
    const content = parsed.content.trim();
    if (content.length > MAX_NOTE_CHARACTERS) {
      return toolResult("rejected", `Notes must be ${MAX_NOTE_CHARACTERS} characters or fewer.`);
    }

    const id = `agent-note-${createHash("sha1").update(content.toLocaleLowerCase()).digest("hex").slice(0, 18)}`;
    const result = await dependencies.recall.workingMemory.addItem(dependencies.scope, {
      id,
      content,
      tokenCount: countNoteTokens(content),
      priority: 5,
    });
    if (!result.accepted) return toolResult("rejected", "Redis could not accept this note within its working-memory token budget.");
    const evicted = result.evicted.length ? ` Evicted ${result.evicted.length} lower-priority note(s) to stay within budget.` : "";
    return toolResult("saved", `Saved the temporary task note.${evicted}`, { tokenUsage: result.tokenUsage });
  }

  if (toolCall.name === "clear_temporary_notes") {
    if (!explicitlyRequestsClear(currentUserMessage)) {
      return toolResult("rejected", "Only clear notes when the current user message explicitly asks to forget or clear temporary task notes.");
    }
    await dependencies.recall.workingMemory.clearSession(dependencies.scope);
    return toolResult("cleared", "Cleared temporary task notes.");
  }

  return toolResult("rejected", `Unknown memory tool: ${toolCall.name}`);
}

function explicitlyRequestsClear(message: string): boolean {
  const clearIntent = /\b(forget|clear|erase|reset|remove)\b/i;
  const noteTarget = /\b(temporary\s+(task\s+)?notes?|working\s+memory|task\s+notes?)\b/i;
  return clearIntent.test(message) && noteTarget.test(message);
}

function toolResult(status: string, detail: string, extra: Record<string, unknown> = {}) {
  return { status, detail, content: JSON.stringify({ status, detail, ...extra }) };
}

function toModelMessages(messages: RecallPromptMessage[]): ChatCompletionMessageParam[] {
  return messages.map(({ role, content }) => ({
    role: role === "tool" ? "assistant" : role,
    content,
  })) as ChatCompletionMessageParam[];
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
