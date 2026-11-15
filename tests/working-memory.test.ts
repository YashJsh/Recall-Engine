import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { RedisWorkingMemory, type WorkingMemoryScope } from "../src/working-memory.js";

const redis = createClient({
  url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
});

const scope = (): WorkingMemoryScope => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  sessionId: randomUUID(),
});

before(async () => {
  await redis.connect();
});

after(async () => {
  await redis.quit();
});

describe("RedisWorkingMemory", () => {
  it("stores items and isolates them by tenant, user, and session", async () => {
    const memory = new RedisWorkingMemory(redis, { tokenBudget: 20, sessionTtlMs: 60_000 });
    const firstScope = scope();
    const secondScope = { ...firstScope, userId: randomUUID() };

    await memory.addItem(firstScope, {
      id: "first", content: "hello", tokenCount: 2, priority: 1,
    });

    assert.deepEqual((await memory.getItems(firstScope)).map(({ id }) => id), ["first"]);
    assert.deepEqual(await memory.getItems(secondScope), []);

    await memory.clearSession(firstScope);
    await memory.clearSession(secondScope);
  });

  it("evicts the lowest-priority unprotected item atomically to stay within budget", async () => {
    const memory = new RedisWorkingMemory(redis, { tokenBudget: 10, sessionTtlMs: 60_000 });
    const session = scope();

    await memory.addItem(session, {
      id: "low", content: "low", tokenCount: 4, priority: 1,
    });
    await memory.addItem(session, {
      id: "protected", content: "keep", tokenCount: 3, priority: 0, protected: true,
    });
    const result = await memory.addItem(session, {
      id: "high", content: "important", tokenCount: 4, priority: 10,
    });

    assert.deepEqual(result, { accepted: true, evicted: ["low"], tokenUsage: 7 });
    assert.deepEqual((await memory.getItems(session)).map(({ id }) => id).sort(), ["high", "protected"]);
    await memory.clearSession(session);
  });

  it("rejects an item that cannot fit without removing existing protected items", async () => {
    const memory = new RedisWorkingMemory(redis, { tokenBudget: 10, sessionTtlMs: 60_000 });
    const session = scope();

    await memory.addItem(session, {
      id: "protected", content: "keep", tokenCount: 6, priority: 0, protected: true,
    });
    const result = await memory.addItem(session, {
      id: "too-large", content: "cannot fit", tokenCount: 5, priority: 10,
    });

    assert.deepEqual(result, { accepted: false, evicted: [], tokenUsage: 6 });
    assert.deepEqual((await memory.getItems(session)).map(({ id }) => id), ["protected"]);
    await memory.clearSession(session);
  });

  it("expires inactive session data in Redis", async () => {
    const memory = new RedisWorkingMemory(redis, { tokenBudget: 10, sessionTtlMs: 80 });
    const session = scope();
    await memory.addItem(session, {
      id: "temporary", content: "expires", tokenCount: 1, priority: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.deepEqual(await memory.getItems(session), []);
  });
});
