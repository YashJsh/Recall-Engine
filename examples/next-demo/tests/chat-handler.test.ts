import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { connectRecallEngine, type RecallEngine, type RecallMemoryScope } from "recall-engine";
import { createChatPostHandler } from "../lib/chat-handler.ts";
import type { HostModel, HostModelResult } from "../lib/agent.ts";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let recall: RecallEngine;
let scope: RecallMemoryScope;
let conversationId: string;
let tenantId: string;
let originalInternalGroqKey: string | undefined;

function queuedModel(responses: HostModelResult[]) {
  const requests: Array<{ messages: unknown[]; tools: unknown[] }> = [];
  const model: HostModel = {
    async complete(input) {
      requests.push({ messages: input.messages, tools: input.tools });
      const response = responses.shift();
      if (!response) throw new Error("The test model has no response queued");
      return response;
    },
  };
  return { model, requests };
}

function postMessage(userMessage: string) {
  return new Request("http://local.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userMessage }),
  });
}

before(async () => {
  originalInternalGroqKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "";
  await pool.connect().then((client) => client.release());
  const tenant = await pool.query<{ id: string }>(
    'INSERT INTO "Tenant" ("id", "name") VALUES (gen_random_uuid(), $1) RETURNING "id"',
    [`Next demo integration ${randomUUID()}`],
  );
  tenantId = tenant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    'INSERT INTO "User" ("id", "tenantId", "externalId") VALUES (gen_random_uuid(), $1, $2) RETURNING "id"',
    [tenantId, randomUUID()],
  );
  const session = await pool.query<{ id: string }>(
    'INSERT INTO "Session" ("id", "tenantId", "userId", "externalId") VALUES (gen_random_uuid(), $1, $2, $3) RETURNING "id"',
    [tenantId, user.rows[0]!.id, randomUUID()],
  );
  scope = { tenantId, userId: user.rows[0]!.id, sessionId: session.rows[0]!.id };
  recall = await connectRecallEngine({
    contextInputTokenBudget: 12_000,
    workingMemoryTokenBudget: 500,
    workingMemorySessionTtlMs: 60_000,
  });
  conversationId = (await recall.conversations.create(scope, "Next demo integration" )).id;
});

after(async () => {
  if (scope && recall) {
    await recall.workingMemory.clearSession(scope).catch(() => undefined);
    await recall.close();
  }
  if (tenantId) await pool.query('DELETE FROM "Tenant" WHERE "id" = $1', [tenantId]);
  await pool.end();
  if (originalInternalGroqKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalInternalGroqKey;
});

describe("Next.js chat handler with Recall Engine", () => {
  it("saves an agent-selected temporary note and includes it on the next turn", async () => {
    const note = "Current task: plan a trip with a $2,000 budget.";
    const queued = queuedModel([
      {
        content: null,
        toolCalls: [{
          id: "save-note-1",
          name: "save_temporary_note",
          arguments: JSON.stringify({ content: note }),
        }],
      },
      { content: "I will keep that trip budget in mind." },
      { content: "The current trip budget is $2,000." },
    ]);
    const handler = createChatPostHandler({
      recall,
      scope,
      conversationId: () => conversationId,
      model: queued.model,
    });

    const firstResponse = await handler(postMessage("Help me plan a trip."));
    const firstBody = await firstResponse.json() as {
      assistantMessage: { content: string };
      semanticMemory: { status: string };
      toolTrace: Array<{ name: string; status: string }>;
      promptCalls: unknown[];
    };
    const savedItems = await recall.workingMemory.getItems(scope);

    assert.equal(firstResponse.status, 200);
    assert.equal(firstBody.assistantMessage.content, "I will keep that trip budget in mind.");
    assert.equal(firstBody.semanticMemory.status, "failed");
    assert.deepEqual(firstBody.toolTrace.map(({ name, status }) => ({ name, status })), [
      { name: "save_temporary_note", status: "saved" },
    ]);
    assert.equal(firstBody.promptCalls.length, 2);
    assert.equal(savedItems.length, 1);
    assert.equal(savedItems[0]?.content, note);
    assert.equal((await recall.conversations.listMessages(scope, conversationId)).length, 2);

    const secondResponse = await handler(postMessage("What budget are we using?"));
    const secondBody = await secondResponse.json() as { assistantMessage: { content: string } };

    assert.equal(secondResponse.status, 200);
    assert.equal(secondBody.assistantMessage.content, "The current trip budget is $2,000.");
    assert.match(JSON.stringify(queued.requests[2]?.messages), /Current task notes/);
    assert.match(JSON.stringify(queued.requests[2]?.messages), /\$2,000/);
    assert.equal((await recall.conversations.listMessages(scope, conversationId)).length, 4);
  });

  it("refuses to clear notes unless the current message explicitly requests it", async () => {
    const note = "Current task: compare three apartments.";
    await recall.workingMemory.clearSession(scope);
    await recall.workingMemory.addItem(scope, {
      id: "existing-task-note",
      content: note,
      tokenCount: 7,
      priority: 5,
    });
    const queued = queuedModel([
      {
        content: null,
        toolCalls: [{ id: "clear-notes-1", name: "clear_temporary_notes", arguments: "{}" }],
      },
      { content: "We can continue comparing apartments." },
    ]);
    const handler = createChatPostHandler({
      recall,
      scope,
      conversationId: () => conversationId,
      model: queued.model,
    });

    const response = await handler(postMessage("Let's compare commute times next."));
    const body = await response.json() as { toolTrace: Array<{ status: string; detail?: string }> };

    assert.equal(response.status, 200);
    assert.equal((await recall.workingMemory.getItems(scope))[0]?.content, note);
    assert.equal(body.toolTrace[0]?.status, "rejected");
    assert.match(body.toolTrace[0]?.detail ?? "", /explicitly ask/i);
  });

  it("stops after three note tool calls and returns the persisted user-message ID", async () => {
    const repeatedSave = (): HostModelResult => ({
      content: null,
      toolCalls: [{
        id: randomUUID(),
        name: "save_temporary_note",
        arguments: JSON.stringify({ content: "A concise temporary note." }),
      }],
    });
    const queued = queuedModel([repeatedSave(), repeatedSave(), repeatedSave(), repeatedSave()]);
    const handler = createChatPostHandler({
      recall,
      scope,
      conversationId: () => conversationId,
      model: queued.model,
    });

    const response = await handler(postMessage("Keep this in mind for the task."));
    const body = await response.json() as {
      error: string;
      resumeUserMessageId: string;
      toolTrace: Array<{ name: string }>;
    };

    assert.equal(response.status, 502);
    assert.match(body.error, /three tool calls/i);
    assert.equal(body.toolTrace.length, 3);
    assert.ok(body.resumeUserMessageId);
    assert.equal(queued.requests.length, 4);
  });
});
