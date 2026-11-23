import { NextResponse } from "next/server";
import { getDemoScope } from "@/lib/demo-identity";
import { readDemoState } from "@/lib/demo-state";
import { getRecallEngine } from "@/lib/recall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Memory-store contents for the inspector's Memory tab. Fetched only when that tab is open. */
export async function GET() {
  try {
    const [scope, recall, state] = await Promise.all([getDemoScope(), getRecallEngine(), readDemoState()]);
    const conversationId = state.conversationId;
    const semanticScope = { tenantId: scope.tenantId, userId: scope.userId };

    const [messages, latestSummary, workingMemoryItems, workingMemoryTokenUsage, facts] = await Promise.all([
      conversationId ? recall.conversations.listMessages(scope, conversationId) : [],
      conversationId ? recall.conversations.getLatestSummary(scope, conversationId) : null,
      recall.workingMemory.getItems(scope),
      recall.workingMemory.getTokenUsage(scope),
      Promise.all(state.savedSemanticMemoryIds.map((id) => recall.semanticMemory.getById(semanticScope, id))),
    ]);

    const knownFacts = facts.filter((fact) => fact !== null);
    const sourceMessages = new Map<string, { id: string; content: string }>();
    for (const fact of knownFacts) {
      if (sourceMessages.has(fact.sourceMessageId)) continue;
      const source = await recall.conversations.getMessage(scope, fact.sourceConversationId, fact.sourceMessageId);
      if (source) sourceMessages.set(source.id, { id: source.id, content: source.content });
    }

    return NextResponse.json({
      messageCount: messages.length,
      latestSummary,
      knownFacts,
      sourceMessages: [...sourceMessages.values()],
      workingMemoryItems,
      workingMemoryTokenUsage,
      workingMemoryTokenBudget: Number(process.env.RECALL_WORKING_MEMORY_TOKEN_BUDGET ?? 4_000),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load memory" },
      { status: 503 },
    );
  }
}
