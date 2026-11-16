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
