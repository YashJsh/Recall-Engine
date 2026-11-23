import { getDemoScope } from "@/lib/demo-identity";
import { activateConversation, readDemoState } from "@/lib/demo-state";
import { getRecallEngine } from "@/lib/recall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts a new conversation, or switches to an earlier one when `conversationId` is given.
 * Either way the Redis task notes are cleared (they belong to the active task); semantic facts are kept.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({})) as { conversationId?: unknown };
    const [scope, recall] = await Promise.all([getDemoScope(), getRecallEngine()]);

    let conversationId: string;
    if (typeof body.conversationId === "string") {
      const state = await readDemoState();
      if (!state.conversationIds.includes(body.conversationId)) {
        return Response.json({ error: "Unknown conversation." }, { status: 404 });
      }
      conversationId = body.conversationId;
    } else {
      conversationId = (await recall.conversations.create(scope, "Memory Lab conversation")).id;
    }

    await recall.workingMemory.clearSession(scope);
    await activateConversation(conversationId);
    return Response.json({ conversationId });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to change conversation" },
      { status: 503 },
    );
  }
}
