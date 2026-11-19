# Conversation Memory Lifecycle Implementation Plan

**Goal:** Give a consuming agent application two memory-side calls: prepare model context before its own chat completion, then persist the reply and attempt semantic-memory extraction afterward.

**Architecture:** `ConversationTurnMemoryService.prepareTurn` persists the user message and calls `ConversationPromptBuilder`. The host app calls its chosen model with the returned messages. `completeTurn` validates the prepared user message against PostgreSQL, persists the assistant response, then extracts from up to eight persisted messages ending at that user message. Extraction failure is reported in the result while the assistant response remains saved.

## Files

- Modify `src/episodic-memory.ts` to add a tenant/user/session/conversation-scoped message lookup for validating a prepared turn.
- Create `src/conversation-turn-memory.ts` for the two-call application boundary and result types.
- Create `tests/conversation-turn-memory.test.ts` for PostgreSQL-backed lifecycle and failure coverage.
- Update `tsconfig.episodic-test.json` and the `test:episodic` script to include the new module and tests.
- Update `README.md` to show the host application calling its own model between `prepareTurn` and `completeTurn`.
- Replace the draft design text with the approved memory-layer boundary and commit this plan.

## Tasks

### 1. Add scoped message lookup

- Add `EpisodicMemory.getMessageById(scope, conversationId, messageId)` scoped through tenant, user, session, and conversation.
- Return the persisted message fields needed to validate role, content, and sequence number; return `null` for an out-of-scope or missing ID.
- Cover a valid lookup and wrong conversation/user scope in episodic integration tests.

### 2. Implement prepare/complete lifecycle

- Add `ConversationTurnMemoryService` with injected `EpisodicMemory`, `ConversationPromptBuilder`, and extraction runner.
- `prepareTurn(scope, conversationId, systemPrompt, userContent)` saves a user-role message, builds the prompt using that exact content, and returns the saved message plus model-ready prompt.
- `completeTurn(scope, preparedTurn, assistantContent)` verifies the prepared message still exists with matching scope, ID, role, sequence, and content; saves the assistant message; loads at most eight messages ending at the user sequence; filters to user/assistant messages; then calls automatic extraction.
- Return a success outcome with the extraction result, or a failed outcome with an error description if extraction throws. Do not roll back or hide the saved assistant reply.
- Test host-model invocation between the two calls, message order and IDs passed to extraction, fact persistence, cross-scope prepared-turn rejection, and extraction failure after assistant persistence.

### 3. Document and verify

- Update the README with the two-call memory-layer pattern and an example where the host app, not Recall Engine, calls its model.
- Update the episodic-test TypeScript include list and test script.
- Run `npm run check`, `npm run build`, and `npm run test:episodic` against local PostgreSQL.
- Do one live memory-side flow with Groq extraction and local Qdrant indexing, while using a fake host model in the harness; verify the consumer prompt, saved assistant message, and extracted fact, then clean up temporary data.

## Review focus

- The host application's conversational model call must remain outside this package.
- Prepared messages must be verified against the supplied owner and conversation before completion.
- Extraction must include nearby prior assistant context but derive provenance only from persisted user messages.
- If extraction fails, the completed assistant message remains available and the caller receives an explicit failed memory outcome.
- The extraction window must exclude the newly generated assistant response from evidence for the same turn.
