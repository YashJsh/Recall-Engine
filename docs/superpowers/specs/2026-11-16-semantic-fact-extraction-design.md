# Semantic Fact Extraction Design

## Goal

Add a manually invoked Groq-backed extractor that proposes durable user facts from a short, ID-tagged conversation context. The caller reviews proposals and decides whether to persist them with `SemanticMemoryStore`.

## Data flow

The caller supplies recent conversation messages, each with a stored message ID, role, and content. User and assistant messages may provide context, but only user messages can support an extracted fact. Groq returns a small list of facts with category and source message ID. The extractor validates the returned shape and rejects any source ID that was not supplied as a user message. It does not access PostgreSQL or persist facts.

## Interface and provider

Expose an async `extract(messages)` service using the existing `GROQ_API_KEY`, `GROQ_MODEL`, and default `openai/gpt-oss-120b` configuration. Define only the message and candidate types needed for this seam. Candidate categories match the current Prisma categories: `preference`, `profile`, and `project_fact`. Use Groq strict JSON Schema output and validate source references in application code.

The prompt treats conversation text as untrusted data, asks for only durable, explicit facts, avoids assistant-authored claims, and returns an empty list when no fact is supported. The extractor returns candidates only; a later caller can show them to a person and pass an accepted candidate to `SemanticMemoryStore.create`.

## Scope

Included: manual service, response validation, fake-client or parser level tests, and a separate live demo using synthetic conversation messages. Excluded: automatic per-turn invocation, persistence, embeddings/vector storage, confidence scoring, conflict detection, and changes to the database schema.

## Acceptance criteria

- A caller can provide a short conversation context with message IDs and receive zero or more typed fact candidates.
- Every candidate cites a supplied user message ID; assistant message IDs are never accepted as evidence.
- Invalid or malformed model output fails clearly rather than becoming a stored fact.
- The service has no persistence side effect and remains independently testable without an API key.
- A separate demo can call Groq and print proposed candidates without writing to the database.

## Provider reference

Groq Structured Outputs documentation lists `openai/gpt-oss-120b` as supporting strict JSON Schema mode: https://console.groq.com/docs/structured-outputs
