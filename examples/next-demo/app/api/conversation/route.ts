import { getDemoScope } from "@/lib/demo-identity";
import { activateConversation, readDemoState } from "@/lib/demo-state";
import { getRecallEngine } from "@/lib/recall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts a new conversation, or switches to an earlier one when `conversationId` is given.
 * Either way the Redis task notes are cleared (they belong to the active task); semantic facts are kept.
 * Starting a new conversation first ends the current one, turning it into a conversation episode.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({})) as { conversationId?: unknown };
    const [scope, recall] = await Promise.all([getDemoScope(), getRecallEngine()]);

    let conversationId: string;
    if (typeof body.conversationId === "string") {
      const known = await recall.conversations.list(scope);
      if (!known.some(({ id }) => id === body.conversationId)) {
        return Response.json({ error: "Unknown conversation." }, { status: 404 });
      }
      conversationId = body.conversationId;
    } else {
      const { conversationId: current } = await readDemoState();
      // Best-effort: create() also finishes any unended conversation it can.
      if (current) await recall.conversations.end(scope, current).catch(() => undefined);
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
