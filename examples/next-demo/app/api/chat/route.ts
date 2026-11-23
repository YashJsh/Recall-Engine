import { GroqHostModel } from "@/lib/agent";
import { createChatPostHandler } from "@/lib/chat-handler";
import { getDemoScope } from "@/lib/demo-identity";
import { activateConversation, readDemoState, updateDemoState } from "@/lib/demo-state";
import { getRecallEngine } from "@/lib/recall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const [scope, recall] = await Promise.all([getDemoScope(), getRecallEngine()]);
    const handler = createChatPostHandler({
      recall,
      scope,
      model: new GroqHostModel(),
      conversationId: async () => {
        const state = await readDemoState();
        if (state.conversationId) return state.conversationId;
        const conversation = await recall.conversations.create(scope, "Memory Lab conversation");
        await activateConversation(conversation.id);
        return conversation.id;
      },
      onSavedFacts: async (ids) => {
        await updateDemoState((current) => ({
          ...current,
          savedSemanticMemoryIds: [...new Set([...current.savedSemanticMemoryIds, ...ids])],
        }));
      },
    });
    return await handler(request);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to start the demo agent" },
      { status: 503 },
    );
  }
}
