# Conversation Memory Lifecycle Design

## Goal

Provide a reusable memory layer behind an agent application. The consuming application owns the conversational model call. Recall Engine prepares context, persists both sides of the conversation, and extracts semantic memories after the application returns its assistant response.

## Application flow

1. The application calls `prepareTurn` with the scoped conversation, the user's message, and its system prompt.
2. Recall Engine persists the user message, retrieves relevant semantic facts, and compacts the summary/recent transcript into model-ready messages. The returned prompt includes the newly saved user message and counts the semantic-memory block against the token budget.
3. The application sends those messages to the conversational model it chooses. This project does not make that chat-completion call.
4. The application passes the model's response to `completeTurn`.
5. Recall Engine persists the assistant response, loads up to eight persisted messages ending at the current user message, and attempts automatic semantic fact extraction/comparison/indexing. This gives extraction nearby assistant context while ensuring evidence is drawn from user messages.
6. `completeTurn` returns the saved assistant message and an explicit memory outcome: success with the extraction result, or failure with an error description. An extraction/indexing failure does not erase the saved assistant response.

## Components

- `ConversationTurnMemoryService` exposes `prepareTurn` and `completeTurn` for the consuming application.
- `ConversationPromptBuilder` continues to assemble summary, exact transcript, and verified semantic memories.
- `AutomaticSemanticMemoryService` remains responsible for extraction, comparison, and persistence.
- Groq remains an internal provider for memory operations such as summary generation, fact extraction, and fact comparison. It is not the consuming application's conversational responder.

## Failure behavior

- If prompt preparation fails after the user message is persisted, the application receives an error and can decide how to resume; the user message remains in history.
- If the application's model call fails, Recall Engine is not involved in that call. The saved user message remains available for a retry.
- If persisting the assistant response fails, `completeTurn` returns an error because history would be incomplete.
- The assistant reply is appended atomically only if the conversation still ends at the prepared user message. If another turn advanced the conversation first, the stale completion is rejected rather than inserted out of order.
- If extraction, comparison, or indexing fails after the assistant response is saved, `completeTurn` returns the assistant response with a failed memory outcome. A partial memory write is possible; the transactional outbox and retry design remains deferred in `IMPROVEMENTS.md` item 5.

## Boundaries

- This slice adds a provider-neutral memory lifecycle, not an HTTP server, UI, CLI chatbot, or conversational model adapter.
- The current user message must already belong to the supplied tenant/user/session and conversation. The service validates prepared-message identity and sequence before completing a turn; only one completion may advance a conversation from that user message.
- Extraction uses a bounded window of up to eight persisted messages ending at the current user message; the newly generated assistant reply is not treated as evidence for that turn's facts.

## Validation

Use PostgreSQL-backed tests with injected prompt/retrieval/extraction dependencies to verify message persistence, scoping, extraction source IDs, and failure behavior. Exercise the boundary with a mock consumer model call between `prepareTurn` and `completeTurn`. A live follow-up may use Groq for extraction, but the consumer model remains outside this package.
