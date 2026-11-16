# Semantic Memory Storage Design

## Goal

Add the first semantic-memory slice to Recall Engine: persist individual facts in PostgreSQL and preserve enough ownership and provenance to trace each fact to the exact conversation message that supports it.

This slice is storage only. It does not extract facts with an LLM, generate embeddings, or connect to Qdrant.

## Domain model

One `SemanticMemory` row represents one asserted fact, for example: “The user prefers Redis for working memory.” Each assertion has a stable UUID. If a later assertion supersedes it, the later assertion receives a different UUID and links to the earlier one. Historical rows remain available for traceability.

The record includes:

- `id`: stable semantic memory ID; Qdrant can use this same ID as its point ID in a later slice.
- `tenantId` and `userId`: ownership and tenant isolation, following the existing composite-scope patterns.
- `content`: human-readable fact text.
- `category`: a small, validated category such as `preference`, `profile`, or `project_fact`.
- `sourceConversationId` and `sourceMessageId`: provenance to the conversation and exact message.
- `status`: active or superseded. Superseded facts remain stored.
- `supersedesMemoryId`: optional link from a new assertion to the older assertion it replaces.
- `createdAt` and `updatedAt`: record lifecycle timestamps.

PostgreSQL is the canonical store for content, ownership, provenance, and status. Later, Qdrant will hold an embedding and filtering metadata that includes the semantic memory ID. Retrieval will use that ID to load and verify the current PostgreSQL record and its source message.

## First implementation slice

1. Add the Prisma model, enums/relations, indexes, and a database migration for semantic memory records.
2. Add a small `SemanticMemoryStore` service for creating a fact and fetching it by ID within a tenant/user scope.
3. Validate referenced ownership and source-message relationships so a fact cannot point across tenants or users.
4. Add PostgreSQL integration coverage for create/read, provenance resolution, scope isolation, and a supersession chain.
5. Document how to run the migration and focused tests.

No API route or demo is added in this slice. The service will be usable by later extraction and retrieval modules.

## Data flow

When a trusted caller supplies a fact, the service persists its content, owner, and source references in PostgreSQL and returns the semantic memory ID. A caller can later fetch by that ID under the same ownership scope and resolve the source message. In the future, Qdrant will return this ID during vector search; PostgreSQL remains the authority for the fact and whether it is active.

## Failure behavior and boundaries

- Missing, mismatched, or cross-scope source references are rejected; no untraceable fact is stored.
- Fetching a fact under the wrong tenant/user scope returns no record, preserving the existing isolation boundary.
- Superseding a fact does not erase or overwrite the prior assertion.
- Confidence scoring, LLM extraction, conflict detection rules, embeddings, Qdrant synchronization, caching, and HTTP endpoints are out of scope.

## Acceptance criteria

- A semantic memory has an ID distinct from its source message ID.
- Given a semantic memory ID, an authorized caller can retrieve the fact and follow its source reference to the exact original message.
- A caller cannot retrieve another tenant's or user's fact by guessing its ID.
- A superseding assertion has its own ID and leaves the prior assertion traceable.
- The migration and integration tests pass against the project's Docker PostgreSQL database.

## Open implementation detail

Use the existing schema's composite tenant/user relations when defining Prisma foreign keys. Keep the category set deliberately small and explicit for the initial migration; expand it only when a concrete extraction use case needs another category.
