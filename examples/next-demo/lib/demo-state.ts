import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface DemoState {
  conversationId?: string;
  /** Every conversation this demo has created, oldest first. */
  conversationIds: string[];
  savedSemanticMemoryIds: string[];
}

const statePath = resolve(process.cwd(), "../../.scratch/next-demo-state.json");
let mutationQueue: Promise<void> = Promise.resolve();

export async function readDemoState(): Promise<DemoState> {
  try {
    const serialized = await readFile(statePath, "utf8");
    const value = JSON.parse(serialized) as Partial<DemoState>;
    const conversationIds = Array.isArray(value.conversationIds)
      ? value.conversationIds.filter((id): id is string => typeof id === "string")
      : [];
    if (typeof value.conversationId === "string" && !conversationIds.includes(value.conversationId)) {
      conversationIds.push(value.conversationId);
    }
    return {
      conversationIds,
      ...(typeof value.conversationId === "string" ? { conversationId: value.conversationId } : {}),
      savedSemanticMemoryIds: Array.isArray(value.savedSemanticMemoryIds)
        ? value.savedSemanticMemoryIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { conversationIds: [], savedSemanticMemoryIds: [] };
    throw error;
  }
}

export async function updateDemoState(
  update: (current: DemoState) => DemoState,
): Promise<DemoState> {
  let updated: DemoState | undefined;
  const operation = mutationQueue.then(async () => {
    const current = await readDemoState();
    updated = update(current);
    const serialized = `${JSON.stringify(updated, null, 2)}\n`;
    await mkdir(dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${process.pid}.tmp`;
    await writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, statePath);
  });
  mutationQueue = operation.catch(() => undefined);
  await operation;
  if (!updated) throw new Error("Demo state was not updated");
  return updated;
}

/** Makes a conversation active and remembers it in the demo's conversation list. */
export function activateConversation(conversationId: string): Promise<DemoState> {
  return updateDemoState((current) => ({
    ...current,
    conversationId,
    conversationIds: current.conversationIds.includes(conversationId)
      ? current.conversationIds
      : [...current.conversationIds, conversationId],
  }));
}
