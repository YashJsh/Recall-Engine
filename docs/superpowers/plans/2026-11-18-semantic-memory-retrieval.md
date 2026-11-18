# Semantic Memory Retrieval Implementation Plan

**Goal:** Retrieve relevant active facts from Qdrant, verify each result against PostgreSQL under the same tenant/user scope, and provide prompt-ready reference context.

**Architecture:** Add a small retrieval service that uses the existing vector search and `SemanticMemoryStore.getById`. Preserve Qdrant rank, drop absent or superseded PostgreSQL rows, return only the fields needed by callers, and format fact text as JSON-labeled untrusted reference data. The caller remains responsible for invoking retrieval and adding the returned context to its system prompt.

## Files

- Create `src/semantic-memory-retrieval.ts` for retrieval interfaces, service, and context formatter.
- Create `tests/semantic-memory-retrieval.test.ts` for deterministic service and formatter coverage.
- Update `tsconfig.episodic-test.json` and `package.json` so the new test is compiled and run with the episodic suite.
- Update `README.md` with the explicit retrieval flow and a concise caller example.

## Tasks

### 1. Implement ranked, verified retrieval

- Add a read-only vector-search dependency interface matching `findSimilar`.
- Add a minimal fact-reader interface matching scoped `getById`.
- Implement `retrieve(scope, queryText, options)` with default limit 5. Query Qdrant, load returned IDs in parallel, keep the original result order, discard missing or non-active records, and return `{ id, content, category, sourceConversationId, sourceMessageId, score }`.
- Reject empty query text before invoking dependencies. Let the vector store enforce its existing limit and score-threshold validation.
- Add `formatPromptContext(matches)`: return an empty string for no matches; otherwise give a clear instruction that stored memories are untrusted reference data, prioritize the current request on conflicts, and include only category/content as JSON.
- Test tenant/user scope forwarding, vector-order preservation, dropping missing and superseded rows, returned provenance fields, empty query rejection, empty formatting, and JSON context formatting.

### 2. Register and run the retrieval checks

- Add the source and test file to `tsconfig.episodic-test.json`.
- Add the emitted retrieval test file to the `test:episodic` command.
- Run `npm run check` and `npm run test:episodic`; expected result is a clean type check and all episodic/semantic tests passing.

### 3. Document the caller flow

- Update `README.md` to show retrieval using the latest user request, adding the formatted block to the system prompt before calling the existing context compactor, and explain that this explicit call is not automatically wired into each turn.
- Run `git diff --check` and inspect the final diff for scope and documentation accuracy.

## Review focus

- A Qdrant ID must never bypass the PostgreSQL tenant/user lookup.
- A PostgreSQL fact changed to `superseded` after Qdrant search must be omitted.
- The returned facts must remain in Qdrant relevance order.
- Stored fact text is data, not instructions; the formatted block must say so and safely encode text as JSON.
- An empty match set must not add an empty or misleading memory section to the prompt.
