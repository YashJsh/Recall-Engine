import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GroqSemanticFactExtractor, type ExtractionInput } from "../src/semantic-fact-extractor.js";

type CreateParams = { messages: Array<{ role: string; content: unknown }> };

function extractorReturning(content: string, capture?: (params: CreateParams) => void) {
  return new GroqSemanticFactExtractor({
    apiKey: "test-key",
    client: {
      chat: {
        completions: {
          create: async (params) => {
            capture?.(params as unknown as CreateParams);
            return { choices: [{ message: { content } }] };
          },
        },
      },
    },
  });
}

const emptyFacts = JSON.stringify({ facts: [] });

const confirmationInput: ExtractionInput = {
  context: [
    { id: "user-1", role: "user", content: "Which should I use?" },
    { id: "assistant-1", role: "assistant", content: "Redis may fit your use case." },
  ],
  target: { id: "user-2", role: "user", content: "Yes, let's use Redis." },
  currentDate: new Date("2026-11-25T10:00:00Z"),
};

describe("GroqSemanticFactExtractor", () => {
  it("returns classified candidates that cite the target message", async () => {
    const candidate = {
      content: "The user chose Redis for working memory.",
      category: "preference",
      kind: "fact",
      durability: 0.85,
      sourceMessageId: "user-2",
    };
    const extractor = extractorReturning(JSON.stringify({ facts: [candidate] }));

    assert.deepEqual(await extractor.extract(confirmationInput), [candidate]);
  });

  it("sends context, target and the current date separately", async () => {
    let request: unknown;
    const extractor = extractorReturning(emptyFacts, (params) => {
      request = JSON.parse(params.messages[1]?.content as string);
    });

    await extractor.extract(confirmationInput);

    assert.deepEqual(request, {
      currentDate: "2026-11-25",
      context: confirmationInput.context,
      target: confirmationInput.target,
    });
  });

  it("instructs the model to judge durability and skip requests, events and task details", async () => {
    let systemPrompt = "";
    const extractor = extractorReturning(emptyFacts, (params) => {
      systemPrompt = params.messages[0]?.content as string;
    });

    await extractor.extract(confirmationInput);

    assert.match(systemPrompt, /still be true and useful weeks from now/i);
    assert.match(systemPrompt, /fun fact today.*request/i);
    assert.match(systemPrompt, /marathon.*2026-11-24.*event/i);
    assert.match(systemPrompt, /current task.*task/i);
    assert.match(systemPrompt, /vegetarian.*fact/i);
    assert.match(systemPrompt, /relative dates/i);
    assert.match(systemPrompt, /standalone statement/i);
    assert.match(systemPrompt, /Do not output.*confirmation/i);
  });

  it("rejects a candidate that cites a context message instead of the target", async () => {
    const extractor = extractorReturning(JSON.stringify({ facts: [{
      content: "The user asked which store to use.",
      category: "project_fact",
      kind: "fact",
      durability: 0.9,
      sourceMessageId: "user-1",
    }] }));

    await assert.rejects(extractor.extract(confirmationInput), /must cite the target user message/);
  });

  it("rejects an assistant message as the target", async () => {
    const extractor = extractorReturning(emptyFacts);

    await assert.rejects(
      extractor.extract({ context: [], target: { id: "assistant-1", role: "assistant", content: "Hi." } }),
      /target must be a user message/,
    );
  });

  it("returns no candidates when nothing is worth remembering", async () => {
    const extractor = extractorReturning(emptyFacts);

    assert.deepEqual(await extractor.extract({
      context: [],
      target: { id: "user-1", role: "user", content: "Give me a fun fact today." },
    }), []);
  });

  it("rejects malformed JSON, unknown categories or kinds, and out-of-range durability", async () => {
    const input: ExtractionInput = {
      context: [],
      target: { id: "user-1", role: "user", content: "I live in Pune." },
    };
    const base = {
      content: "The user lives in Pune.",
      category: "profile",
      kind: "fact",
      durability: 0.9,
      sourceMessageId: "user-1",
    };
    const withFact = (fact: Record<string, unknown>) => extractorReturning(JSON.stringify({ facts: [fact] }));

    await assert.rejects(extractorReturning("not json").extract(input), /invalid JSON/);
    await assert.rejects(withFact({ ...base, category: "location" }).extract(input), /invalid semantic fact candidate/);
    await assert.rejects(withFact({ ...base, kind: "opinion" }).extract(input), /invalid semantic fact candidate/);
    await assert.rejects(withFact({ ...base, durability: 1.5 }).extract(input), /invalid semantic fact candidate/);
    await assert.rejects(withFact({ ...base, durability: "high" }).extract(input), /invalid semantic fact candidate/);
  });
});
