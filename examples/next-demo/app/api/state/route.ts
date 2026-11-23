import { NextResponse } from "next/server";
import { getDemoScope } from "@/lib/demo-identity";
import { activateConversation, readDemoState } from "@/lib/demo-state";
import { getRecallEngine } from "@/lib/recall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [scope, recall] = await Promise.all([getDemoScope(), getRecallEngine()]);
    let state = await readDemoState();
    if (!state.conversationId) {
      const conversation = await recall.conversations.create(scope, "Memory Lab conversation");
      state = await activateConversation(conversation.id);
    }

    const conversationId = state.conversationId!;
    // Transcript and conversation list only. Memory contents load from /api/memory when the
    // Memory tab is opened; each turn's recalled facts come from that turn's semantic search.
    const [messages, conversationOverviews] = await Promise.all([
      recall.conversations.listMessages(scope, conversationId),
      recall.conversations.list(scope),
    ]);
    const conversations = conversationOverviews.map((conversation) => ({
      id: conversation.id,
      title: conversation.preview?.slice(0, 80) ?? "New conversation",
      messageCount: conversation.messageCount,
      lastActivityAt: conversation.lastMessageAt ?? conversation.startedAt,
    }));

    return NextResponse.json({
      conversationId,
      conversations,
      messages,
      savedFactCount: state.savedSemanticMemoryIds.length,
      contextInputTokenBudget: Number(process.env.DEMO_CONTEXT_INPUT_TOKEN_BUDGET ?? 12_000),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load demo memory state" },
      { status: 503 },
    );
  }
}
