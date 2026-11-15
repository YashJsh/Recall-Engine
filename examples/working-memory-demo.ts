import { RedisWorkingMemory } from "../src/working-memory.js";
import { connectRedis } from "../src/redis-client.js";

const scope = {
  tenantId: "local-demo-tenant",
  userId: "local-demo-user",
  sessionId: "local-demo-session",
};

async function main(): Promise<void> {
  const redis = await connectRedis();
  const workingMemory = new RedisWorkingMemory(redis, {
    tokenBudget: 8,
    sessionTtlMs: 60_000,
  });

  try {
    await workingMemory.clearSession(scope);

    await workingMemory.addItem(scope, {
      id: "system-context",
      content: "Follow the user’s project constraints.",
      tokenCount: 3,
      priority: 100,
      protected: true,
    });
    await workingMemory.addItem(scope, {
      id: "older-message",
      content: "Earlier user request.",
      tokenCount: 4,
      priority: 10,
    });
    const result = await workingMemory.addItem(scope, {
      id: "latest-message",
      content: "Current user request.",
      tokenCount: 3,
      priority: 50,
    });

    console.log("Add result:", result);
    console.log("Current working memory:", await workingMemory.getItems(scope));
  } finally {
    await workingMemory.clearSession(scope);
    await redis.close();
  }
}

main().catch((error: unknown) => {
  console.error("Working memory demo failed:", error);
  process.exitCode = 1;
});
