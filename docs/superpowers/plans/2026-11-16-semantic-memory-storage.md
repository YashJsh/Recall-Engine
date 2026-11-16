# Semantic Memory Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist user-owned semantic facts in PostgreSQL with a stable ID and a trace to the exact source message.

**Architecture:** Add one `SemanticMemory` record per asserted fact. PostgreSQL owns the fact, scope, source reference, and lifecycle; the store validates a source message and performs supersession transactionally. LLM extraction and Qdrant indexing remain later stages.

**Tech Stack:** TypeScript strict mode, Prisma, PostgreSQL in Docker, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-16-semantic-memory-storage-design.md`

## Global Constraints

- Use the existing TypeScript, Prisma, and PostgreSQL setup; add no dependencies.
- Keep implementation in focused source files and tests in `tests/`.
- Keep PostgreSQL as the canonical record; do not add Qdrant, embeddings, or LLM extraction in this slice.
- Run the integration tests against the project's Docker PostgreSQL database.

## Review Focus

1. A missing source message must reject the write and leave no memory record (`rejects missing source message`).
2. A source message from another user's conversation in the same tenant must be rejected (`rejects source message owned by another user`).
3. A source message must belong to the supplied source conversation (`rejects message from a different conversation`).
4. Fetch by a valid memory ID under a different tenant or user must return no record (`scopes ID lookup to tenant and user`).
5. A fact may supersede only an active fact owned by the same user; the old row must remain traceable (`supersedes fact and retains the predecessor`, `rejects invalid supersession target`).

---

### Task 1: Add the PostgreSQL semantic memory store

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<generated-timestamp>_add_semantic_memory/migration.sql`
- Create: `src/semantic-memory.ts`
- Create: `tests/semantic-memory.test.ts`
- Modify: `tsconfig.episodic-test.json`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: Prisma client from `src/postgres-client.ts`; conversation and message records from `EpisodicMemory`'s existing schema.
- Produces: `SemanticMemoryStore.create(scope, input)` and `SemanticMemoryStore.getById(scope, memoryId)`.
- `SemanticMemoryScope` contains `tenantId` and `userId`.
- `CreateSemanticMemoryInput` contains `content`, `category`, `sourceConversationId`, `sourceMessageId`, and optional `supersedesMemoryId`.
- `SemanticMemoryRecord` is `Prisma.SemanticMemoryGetPayload<{ include: { sourceMessage: { include: { conversation: true } } } }>`.
- `create(scope: SemanticMemoryScope, input: CreateSemanticMemoryInput): Promise<SemanticMemoryRecord>` returns the new fact and source; `getById(scope: SemanticMemoryScope, memoryId: string): Promise<SemanticMemoryRecord | null>` returns `null` for an ID outside the supplied scope.
- Categories are `preference`, `profile`, and `project_fact`; statuses are `active` and `superseded`.
- If `supersedesMemoryId` is supplied, `create` only replaces an active fact for the same tenant/user, marks that predecessor superseded, and creates the new row in the same transaction. Invalid or already superseded targets raise `SemanticMemorySupersessionError`.
- Invalid/missing source references raise `SemanticMemorySourceError`; content and scope are validated before persistence.

- [x] **Step 1: Write the PostgreSQL integration tests** in `tests/semantic-memory.test.ts` for creating and tracing a fact; missing or mismatched source rejection; same-tenant cross-user rejection; tenant/user-scoped ID lookup; successful supersession with the predecessor retained; and invalid supersession rejection. Use separate tenant/user/session/conversation fixtures, following the setup and cleanup pattern in `tests/episodic-memory.test.ts`.

- [x] **Step 2: Run the focused test command to confirm the tests fail before implementation.** Add the new test file to `tsconfig.episodic-test.json` and the Node test command in `package.json` first.

  Run: `npm run test:episodic`

  Expected: FAIL because the semantic memory store/model does not exist yet.

- [x] **Step 3: Add the Prisma schema and migration.** Add the category and status enums and `SemanticMemory` model with a UUID ID, tenant/user ownership, fact text, source conversation/message IDs, optional superseded-memory ID, and timestamps. Add the relations and indexes needed to enforce tenant/source-message integrity and query a user's active facts. Generate and apply the migration using the existing scripts.

  Run: `npm run db:migrate`

  Expected: Prisma creates/applies the semantic memory migration and regenerates the client without errors.

- [x] **Step 4: Implement `SemanticMemoryStore` in `src/semantic-memory.ts`.** Validate owner scope and nonblank content. Confirm the source message belongs to the supplied source conversation and that its conversation belongs to the supplied tenant/user. In a Prisma transaction, validate and mark an optional active predecessor as superseded, then create the new record. Fetch by ID with tenant/user filters and include the source message (and its conversation) so callers can trace the fact.

- [x] **Step 5: Run the focused PostgreSQL integration tests and verify they pass.**

  Run: `npm run test:episodic`

  Expected: All episodic and semantic memory integration tests pass; semantic cases prove provenance, isolation, and supersession behavior.

- [x] **Step 6: Document the new storage slice in `README.md`.** Explain the distinction between PostgreSQL's canonical fact/provenance record and future Qdrant indexing, and document the migration and focused-test commands.

- [x] **Step 7: Run project checks and inspect the final diff.**

  Run: `npm run check`

  Expected: TypeScript check passes.

  Run: `npm run build`

  Expected: Production TypeScript build passes.

  Run: `git diff --check`

  Expected: No whitespace errors.

- [x] **Step 8: Commit the completed storage slice.**

  ```bash
  git add prisma/schema.prisma prisma/migrations src/semantic-memory.ts tests/semantic-memory.test.ts tsconfig.episodic-test.json package.json README.md
  git commit -m "Add PostgreSQL semantic memory storage"
  ```
