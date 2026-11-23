import { NextResponse, type NextRequest } from "next/server";
import { getDemoScope } from "@/lib/demo-identity";
import { readDemoState } from "@/lib/demo-state";
import { getRecallEngine } from "@/lib/recall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LAYERS = ["working", "episodic", "semantic"] as const;
type Layer = (typeof LAYERS)[number];

/** One memory layer for the inspector's Memory tab: GET /api/memory?layer=working|episodic|semantic. */
export async function GET(request: NextRequest) {
  const layer = request.nextUrl.searchParams.get("layer");
  if (!LAYERS.includes(layer as Layer)) {
    return NextResponse.json({ error: `layer must be one of ${LAYERS.join(", ")}` }, { status: 400 });
  }

  try {
    const [scope, recall, state] = await Promise.all([getDemoScope(), getRecallEngine(), readDemoState()]);

    if (layer === "working") {
      const [items, tokenUsage] = await Promise.all([
        recall.workingMemory.getItems(scope),
        recall.workingMemory.getTokenUsage(scope),
      ]);
      return NextResponse.json({
        layer,
        items,
        tokenUsage,
        tokenBudget: Number(process.env.RECALL_WORKING_MEMORY_TOKEN_BUDGET ?? 4_000),
      });
    }

    if (layer === "episodic") {
      const conversationId = state.conversationId;
      const [messages, summaryVersions] = conversationId
        ? await Promise.all([
            recall.conversations.listMessages(scope, conversationId),
            recall.conversations.listSummaryVersions(scope, conversationId),
          ])
        : [[], []];
      const latest = summaryVersions.reduce<(typeof summaryVersions)[number] | null>(
        (best, summary) => (!best || summary.version > best.version ? summary : best),
        null,
      );
      return NextResponse.json({
        layer,
        messageCount: messages.length,
        userMessageCount: messages.filter((m) => m.role === "user").length,
        assistantMessageCount: messages.filter((m) => m.role === "assistant").length,
        latestSummary: latest,
        earlierSummaries: summaryVersions.filter((s) => s !== latest).sort((a, b) => b.version - a.version),
      });
    }

    const semanticScope = { tenantId: scope.tenantId, userId: scope.userId };
    const facts = (await Promise.all(
      state.savedSemanticMemoryIds.map((id) => recall.semanticMemory.getById(semanticScope, id)),
    )).filter((fact) => fact !== null);
    const sourceMessages = new Map<string, { id: string; content: string }>();
    for (const fact of facts) {
      if (sourceMessages.has(fact.sourceMessageId)) continue;
      const source = await recall.conversations.getMessage(scope, fact.sourceConversationId, fact.sourceMessageId);
      if (source) sourceMessages.set(source.id, { id: source.id, content: source.content });
    }
    return NextResponse.json({ layer, facts, sourceMessages: [...sourceMessages.values()] });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load memory" },
      { status: 503 },
    );
  }
}
