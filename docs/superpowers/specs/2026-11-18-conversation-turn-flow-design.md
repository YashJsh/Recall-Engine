# Conversation Turn Flow Design

## Goal

Provide one reusable application call that accepts a user's message, assembles conversation and semantic-memory context, asks Groq for an assistant reply, persists the reply, and then attempts automatic semantic fact extraction.

## Flow

1. Persist the current user message in the scoped conversation.
2. Build the model prompt with `ConversationPromptBuilder`, using the just-persisted message as the semantic retrieval query. The existing compactor includes the summary and recent exact transcript and counts the retrieved memory block in the token budget.
3. Send the model-ready messages to an `AssistantResponder`. The default adapter calls Groq using `GROQ_MODEL`, defaulting to `openai/gpt-oss-120b`.
4. Persist the assistant reply and retain it for the caller.
5. Load up to eight persisted messages ending at the current user message (so the extraction window can include the preceding assistant turn without treating the new assistant response as evidence). Call `AutomaticSemanticMemoryService.extractAndSave`; its existing source validation permits facts only from user messages.
6. Return the user/assistant records, retrieved facts, and extraction result or an extraction error status.

## Failure behavior

- If Groq chat generation fails, the already-persisted user message remains in the transcript and the turn fails; the caller can decide whether to retry.
- If persisting the assistant reply fails, return an error even if the provider generated text, because the conversation history would otherwise be incomplete.
- If semantic extraction, comparison, or indexing fails after the assistant reply is saved, return the assistant reply successfully and include a memory-extraction failure status. This keeps the conversation usable while making the secondary memory failure visible to the caller.
- The PostgreSQL/Qdrant dual-write recovery remains deferred in `IMPROVEMENTS.md` item 5.

## Boundaries

- Add a provider-neutral `AssistantResponder` interface and a `GroqAssistantResponder` implementation.
- Add a `ConversationTurnService` that orchestrates the stores and services already in the project.
- Add a bounded recent-message query to `EpisodicMemory` for the extraction window, preserving message IDs and roles.
- Keep HTTP routing, streaming, tool calls, and a user interface out of this slice.
- The application caller invokes the turn service explicitly; this does not create a server or automatically process every database append.

## Validation

Use injected responder and extractor dependencies to verify message ordering, persistence, scoped prompt construction, extraction source IDs, and failure behavior. Run the episodic/semantic integration suite against PostgreSQL. Afterward, make one live Groq turn with temporary data to verify that the configured model returns an answer and the extraction result is reported; clean up all temporary database/vector data.
