import { getDemoScope } from "@/lib/demo-identity";
import { updateDemoState } from "@/lib/demo-state";
import { getRecallEngine } from "@/lib/recall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts a new transcript and clears working memory; semantic facts are kept. */
export async function POST(): Promise<Response> {
  try {
    const [scope, recall] = await Promise.all([getDemoScope(), getRecallEngine()]);
    const conversation = await recall.conversations.create(scope, "Memory Lab conversation");
    await recall.workingMemory.clearSession(scope);
    await updateDemoState((current) => ({ ...current, conversationId: conversation.id }));
    return Response.json({ conversationId: conversation.id });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to start a new conversation" },
      { status: 503 },
    );
  }
}
