# Future Improvements

## Keep the conversation's original user prompt available during summarization

**Status:** Deferred until the project is complete. The current summary flow is acceptable for now.

### Current behavior

Each summary generation receives the previous summary and the newly selected messages. The original user prompt is available only if it is still in that message batch, or if earlier summaries preserved it accurately.

### Proposed improvement

Keep the conversation's initial user prompt (or a concise, explicitly confirmed statement of the user's original goal) as a durable context anchor. Include that anchor in every summary-generation request alongside the previous summary and newly selected messages. This should help later summaries preserve the reason the conversation began, even after many compaction rounds.

### End-of-project evaluation

Before and after implementing the anchor, run the same representative long conversations through both summary flows. Compare whether each final summary retains the original user goal, key constraints, and decisions. Record examples where the anchored version improves the result, makes no difference, or causes unwanted bias. Keep this as an evaluation first; decide whether to retain the change based on the observed summaries.

## Enforce semantic-memory supersession links in PostgreSQL

**Status:** Deferred. `SemanticMemoryStore` validates supersession targets, but the database does not enforce this relationship.

### Current behavior and risk

`SemanticMemory.supersedesMemoryId` is stored as a UUID and checked by the store against an active fact owned by the same tenant and user. A write that bypasses the store, such as direct SQL or a future code path using Prisma directly, could still create a dangling link or point to a fact owned by another user. The database would accept it, making the history chain unreliable.

### Proposed improvement

Add a self-relation with a composite foreign key from `(tenantId, userId, supersedesMemoryId)` to `(tenantId, userId, id)`. Define the deletion behavior deliberately so removing or retaining prior facts cannot silently break a chain. Add migration and integration coverage for a valid same-owner link, a missing predecessor, a cross-owner predecessor, and deletion behavior.

## Preserve complete evidence for facts confirmed across turns

**Status:** Deferred until the semantic extraction and storage flows are evaluated together.

### Current behavior and risk

The extractor rewrites short confirmations into standalone facts. Its candidate and the current `SemanticMemory` record carry only one `sourceMessageId`. In the live sample, a combined Redis/PostgreSQL fact cited the user's short “Yes, that is the design I want” reply. The fact text made sense on its own, but following that one source message did not show what the user had confirmed.

A second live sample showed the prompt instruction is not enough to guarantee standalone facts. Given “I can remind you every Friday at 9 AM” followed by “Yes, Friday at 9 AM works,” the extractor returned “The user agrees to a reminder on Friday at 9 AM” instead of stating the reminder preference directly. We need to iterate on this behavior and test it with a small set of confirmation examples before relying on extracted candidates.

### Proposed improvement

Keep the fact text self-contained, and support multiple provenance references so a stored fact can point to the original user statement and later user confirmation. If assistant messages are retained to explain context, keep them explicitly separate from user evidence. Iterate on prompt and/or validation behavior until confirmations are converted to the underlying fact, then evaluate a set of examples and confirm a reviewer can understand both the fact and why it was extracted from its provenance.
