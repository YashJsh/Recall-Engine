import { NextResponse } from "next/server";
import { getDemoScope } from "@/lib/demo-identity";
import { readDemoState, updateDemoState } from "@/lib/demo-state";
import { getRecallEngine } from "@/lib/recall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [scope, recall] = await Promise.all([getDemoScope(), getRecallEngine()]);
    let state = await readDemoState();
    if (!state.conversationId) {
      const conversation = await recall.conversations.create(scope, "Memory Lab conversation");
      state = await updateDemoState((current) => ({ ...current, conversationId: conversation.id }));
    }

    const conversationId = state.conversationId!;
    const [messages, latestSummary, workingMemoryItems, workingMemoryTokenUsage, facts] = await Promise.all([
      recall.conversations.listMessages(scope, conversationId),
      recall.conversations.getLatestSummary(scope, conversationId),
      recall.workingMemory.getItems(scope),
      recall.workingMemory.getTokenUsage(scope),
      Promise.all(state.savedSemanticMemoryIds.map((id) => recall.semanticMemory.getById(
        { tenantId: scope.tenantId, userId: scope.userId },
        id,
      ))),
    ]);

    const knownFacts = facts.filter((fact) => fact !== null);
    const sourceMessages = new Map<string, { id: string; conversationId: string; content: string; role: string }>();
    for (const fact of knownFacts) {
      if (sourceMessages.has(fact.sourceMessageId)) continue;
      const source = await recall.conversations.listMessages(scope, fact.sourceConversationId);
      const sourceMessage = source.find((message) => message.id === fact.sourceMessageId);
      if (sourceMessage) {
        sourceMessages.set(sourceMessage.id, {
          id: sourceMessage.id,
          conversationId: sourceMessage.conversationId,
          content: sourceMessage.content,
          role: sourceMessage.role,
        });
      }
    }

    return NextResponse.json({
      conversationId,
      messages,
      latestSummary,
      knownFacts,
      sourceMessages: [...sourceMessages.values()],
      workingMemoryItems,
      workingMemoryTokenUsage,
      workingMemoryTokenBudget: Number(process.env.RECALL_WORKING_MEMORY_TOKEN_BUDGET ?? 4_000),
      contextInputTokenBudget: Number(process.env.DEMO_CONTEXT_INPUT_TOKEN_BUDGET ?? 12_000),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load demo memory state" },
      { status: 503 },
    );
  }
}
