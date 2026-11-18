# Semantic Memory Retrieval Design

## Goal

Let an application retrieve durable facts that are relevant to the user's current request and include them as reference context for the model. PostgreSQL remains authoritative for fact text, ownership, status, and provenance; Qdrant supplies semantic ranking only.

## Scope

- Search Qdrant with the current tenant ID, user ID, and active status filters.
- Load each returned semantic-memory ID from PostgreSQL under the same tenant/user scope.
- Keep Qdrant's relevance order while dropping missing or no-longer-active PostgreSQL records.
- Return ranked facts with similarity scores and provide a clearly labeled prompt-context block that treats fact text as untrusted reference data, not instructions.
- Let the caller use the latest user request as the retrieval query and include the returned context in its system prompt. The existing context compactor will count it as part of that prompt.

## Data flow

1. The caller supplies a tenant/user scope and the current user request.
2. FastEmbed creates a query embedding and Qdrant returns a bounded list of active fact IDs for that same scope.
3. PostgreSQL loads those IDs using its existing scoped lookup.
4. The retrieval service drops missing and superseded rows, retains the vector ranking, and returns the verified fact records with scores.
5. A formatter places the facts in a separate labeled reference section. The model is instructed to use them only as data and to follow the system instructions when fact text contains instruction-like content.

If Qdrant is unavailable, retrieval reports the failure to the caller. It does not scan all PostgreSQL facts as a fallback because that would change semantic search into an unbounded or non-semantic lookup. An empty search result produces no memory context.

## Interface direction

Add a small `SemanticMemoryRetrievalService` that depends on the existing vector-search interface and `SemanticMemoryStore`. Its retrieval method accepts scope, query text, and bounded search options; it returns ranked verified facts and scores. A pure formatter converts those matches into prompt-ready text. Keep provider calls and automatic per-turn invocation out of this slice.

## Alternatives considered

1. **Qdrant IDs plus PostgreSQL verification (recommended):** uses semantic ranking while preserving PostgreSQL ownership/status checks and canonical text.
2. **Scan all PostgreSQL facts:** avoids Qdrant dependency but does not provide semantic retrieval and scales with a user's full fact history.
3. **Use Qdrant payload as the fact source:** simpler reads, but duplicates canonical text and status and can serve stale or cross-scope data if indexing is wrong.

## Out of scope

- Transactional outbox, retries, or reconciliation; item 5 in `IMPROVEMENTS.md` tracks this for a later iteration.
- Calling retrieval automatically on every conversation turn.
- Changing extraction, comparison, or fact-write behavior.
- Adding a chat API or model-provider call.

## Validation

Cover tenant/user scoping, relevance order, stale and superseded ID filtering, empty results, query validation, result limits, and prompt formatting. Run the PostgreSQL integration suite for persisted-record verification and use injected vector-search results for deterministic retrieval behavior.
