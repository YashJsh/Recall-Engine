import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GroqSemanticFactExtractor } from "../src/semantic-fact-extractor.js";

describe("GroqSemanticFactExtractor", () => {
  it("returns candidates with source IDs from user messages only", async () => {
    const extractor = new GroqSemanticFactExtractor({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: JSON.stringify({ facts: [
                {
                  content: "The user chose Redis for working memory.",
                  category: "preference",
                  sourceMessageId: "user-2",
                },
              ] }) } }],
            }),
          },
        },
      },
    });

    const candidates = await extractor.extract([
      { id: "user-1", role: "user", content: "Which should I use?" },
      { id: "assistant-1", role: "assistant", content: "Redis may fit your use case." },
      { id: "user-2", role: "user", content: "Yes, let's use Redis." },
    ]);

    assert.deepEqual(candidates, [{
      content: "The user chose Redis for working memory.",
      category: "preference",
      sourceMessageId: "user-2",
    }]);
  });

  it("instructs Groq to write standalone facts instead of confirmation statements", async () => {
    let systemPrompt = "";
    const extractor = new GroqSemanticFactExtractor({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
            create: async (params) => {
              systemPrompt = params.messages[0]?.role === "system" ? params.messages[0].content as string : "";
              return { choices: [{ message: { content: JSON.stringify({ facts: [] }) } }] };
            },
          },
        },
      },
    });

    await extractor.extract([{ id: "user-1", role: "user", content: "Yes, that is right." }]);

    assert.match(systemPrompt, /standalone statement/i);
    assert.match(systemPrompt, /Do not output.*confirmation/i);
  });

  it("includes examples for confirmations and corrections", async () => {
    let systemPrompt = "";
    const extractor = new GroqSemanticFactExtractor({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
            create: async (params) => {
              systemPrompt = params.messages[0]?.role === "system" ? params.messages[0].content as string : "";
              return { choices: [{ message: { content: JSON.stringify({ facts: [] }) } }] };
            },
          },
        },
      },
    });

    await extractor.extract([{ id: "user-1", role: "user", content: "Use Redis." }]);

    assert.match(systemPrompt, /weekly review reminder on Fridays at 9 AM/i);
    assert.match(systemPrompt, /correction/i);
    assert.match(systemPrompt, /user wants to use Redis for working memory/i);
  });

  it("rejects a candidate that cites assistant or unknown context", async () => {
    const extractor = new GroqSemanticFactExtractor({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: JSON.stringify({ facts: [
                { content: "An unsupported claim.", category: "profile", sourceMessageId: "assistant-1" },
              ] }) } }],
            }),
          },
        },
      },
    });

    await assert.rejects(
      extractor.extract([
        { id: "user-1", role: "user", content: "Hello." },
        { id: "assistant-1", role: "assistant", content: "You like hiking." },
      ]),
      /must cite a supplied user message/,
    );
  });

  it("returns no candidates when Groq finds no durable fact", async () => {
    const extractor = new GroqSemanticFactExtractor({
      apiKey: "test-key",
      client: {
        chat: { completions: { create: async () => ({ choices: [
          { message: { content: JSON.stringify({ facts: [] }) } },
        ] }) } },
      },
    });

    assert.deepEqual(await extractor.extract([
      { id: "user-1", role: "user", content: "Hi." },
    ]), []);
  });

  it("rejects malformed JSON and unsupported categories", async () => {
    const makeExtractor = (content: string) => new GroqSemanticFactExtractor({
      apiKey: "test-key",
      client: {
        chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } },
      },
    });
    const messages = [{ id: "user-1", role: "user" as const, content: "I live in Pune." }];

    await assert.rejects(makeExtractor("not json").extract(messages), /invalid JSON/);
    await assert.rejects(
      makeExtractor(JSON.stringify({ facts: [
        { content: "The user lives in Pune.", category: "location", sourceMessageId: "user-1" },
      ] })).extract(messages),
      /invalid semantic fact candidate/,
    );
  });
});
