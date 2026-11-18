# Future Improvements

## 1. Keep the conversation's original user prompt available during summarization

**Status:** Deferred until the project is complete. The current summary flow is acceptable for now.

### Current behavior

Each summary generation receives the previous summary and the newly selected messages. The original user prompt is available only if it is still in that message batch, or if earlier summaries preserved it accurately.

### Proposed improvement

Keep the conversation's initial user prompt (or a concise, explicitly confirmed statement of the user's original goal) as a durable context anchor. Include that anchor in every summary-generation request alongside the previous summary and newly selected messages. This should help later summaries preserve the reason the conversation began, even after many compaction rounds.

### End-of-project evaluation

Before and after implementing the anchor, run the same representative long conversations through both summary flows. Compare whether each final summary retains the original user goal, key constraints, and decisions. Record examples where the anchored version improves the result, makes no difference, or causes unwanted bias. Keep this as an evaluation first; decide whether to retain the change based on the observed summaries.

## 2. Enforce semantic-memory supersession links in PostgreSQL

**Status:** Deferred. `SemanticMemoryStore` validates supersession targets, but the database does not enforce this relationship.

### Current behavior and risk

`SemanticMemory.supersedesMemoryId` is stored as a UUID and checked by the store against an active fact owned by the same tenant and user. A write that bypasses the store, such as direct SQL or a future code path using Prisma directly, could still create a dangling link or point to a fact owned by another user. The database would accept it, making the history chain unreliable.

### Proposed improvement

Add a self-relation with a composite foreign key from `(tenantId, userId, supersedesMemoryId)` to `(tenantId, userId, id)`. Define the deletion behavior deliberately so removing or retaining prior facts cannot silently break a chain. Add migration and integration coverage for a valid same-owner link, a missing predecessor, a cross-owner predecessor, and deletion behavior.

## 3. Preserve complete evidence for facts confirmed across turns

**Status:** Deferred until the semantic extraction and storage flows are evaluated together.

### Current behavior and risk

The extractor rewrites short confirmations into standalone facts. Its candidate and the current `SemanticMemory` record carry only one `sourceMessageId`. In the live sample, a combined Redis/PostgreSQL fact cited the user's short “Yes, that is the design I want” reply. The fact text made sense on its own, but following that one source message did not show what the user had confirmed.

A second live sample showed the prompt instruction is not enough to guarantee standalone facts. Given “I can remind you every Friday at 9 AM” followed by “Yes, Friday at 9 AM works,” the extractor returned “The user agrees to a reminder on Friday at 9 AM” instead of stating the reminder preference directly. We need to iterate on this behavior and test it with a small set of confirmation examples before relying on extracted candidates.

The prompt now includes explicit confirmation and correction examples. A follow-up live check returned “The user wants a weekly review reminder on Fridays at 9 AM” for the confirmation case, and “The user wants to use Redis directly for working memory” for a Redis correction. These two examples pass, but broader evaluation is still needed. The confirmation cites the confirming user message, while the correction cites the original user statement.

### Proposed improvement

Keep the fact text self-contained, and support multiple provenance references so a stored fact can point to the original user statement and later user confirmation. If assistant messages are retained to explain context, keep them explicitly separate from user evidence. Expand the confirmation/correction evaluation set and confirm a reviewer can understand both each fact and why it was extracted from its provenance.

## 4. Avoid saving the same fact across repeated extraction runs

**Status:** Partly addressed; semantic comparison now runs when Qdrant is configured.

### Current behavior and risk

`AutomaticSemanticMemoryService` searches Qdrant for up to five similar active facts for the same tenant/user and asks Groq whether each candidate is the same, new, updated, or uncertain. This avoids many repeated writes when the vector index is current. It does not provide a database idempotency guarantee if Qdrant is unavailable, stale, or omitted from service configuration.

### Proposed improvement

Before attaching automatic extraction to every turn, make indexing durable and retryable, then evaluate repeated mentions across separate calls. Add a database-level idempotency or reconciliation strategy for vector-index failures.

## 5. Keep PostgreSQL and Qdrant indexes in sync

**Status:** Deferred to a later iteration; the current app service writes PostgreSQL first, then Qdrant.

### Current behavior and risk

PostgreSQL is authoritative. If a Qdrant upsert fails after the PostgreSQL fact is created, the fact remains valid but is missing from semantic search. A supersession can also update PostgreSQL while the matching Qdrant status update fails, leaving an outdated vector searchable until it is repaired. PostgreSQL and Qdrant do not share a transaction, so they cannot be changed atomically at the exact same moment.

### Proposed improvement

Use a transactional outbox in PostgreSQL. In the same PostgreSQL transaction that creates a fact or supersedes an existing one, save durable work describing the required Qdrant upsert and status change. A retryable worker processes that work and marks it complete only after Qdrant confirms the change. Use the stable semantic-memory ID so retries are idempotent, and provide a reconciliation path to find and repair missing or stale vectors.

This gives recoverable eventual consistency: if Qdrant is unavailable, the PostgreSQL fact and its pending indexing work remain durable, and processing can resume later. PostgreSQL stays the source of truth; semantic search should continue verifying returned IDs and active status against PostgreSQL. This does not provide instantaneous all-or-nothing commits across both systems, because they do not participate in one shared transaction.

### Recovery evaluation

Test failures after the PostgreSQL transaction, during the Qdrant upsert, and after Qdrant succeeds but before the outbox item is marked complete. Confirm retries do not create duplicate vectors, superseded facts stop appearing as active after recovery, and reconciliation repairs a deliberately missing or stale vector.
