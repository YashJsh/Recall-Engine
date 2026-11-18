# Recall Engine

Recall Engine is being built incrementally as reusable memory infrastructure for AI agents.

## Current slices

- Redis-backed working memory with token budgets, priority eviction, protected items, and session TTL.
- PostgreSQL episodic memory for tenant-scoped sessions, conversations, exact message history, and versioned summaries.

## Local PostgreSQL

Copy `.env.example` to `.env`, then run:

```sh
npm install
npm run db:up
npm run db:generate
npm run db:migrate
```

PostgreSQL data is kept in a Docker volume. Stop the container with `npm run db:down`; the volume remains for the next run.

## Episodic memory

`EpisodicMemory` creates conversations, appends messages in a transaction, and retrieves exact messages in sequence-number order. Message sequence numbers are allocated by incrementing a counter on the conversation row inside the same transaction as the insert. This keeps concurrent appends ordered and avoids gaps when an insert rolls back.

`saveSummary` stores supplied summary text as a versioned checkpoint through a message sequence number. Earlier versions are retained. `ConversationSummaryService` selects only messages after the previous checkpoint and through the requested sequence, asks a provider-neutral `SummaryGenerator` to summarize them, then persists the result. The current `GroqSummaryGenerator` uses Groq's chat-completions API. Set `GROQ_API_KEY` in your local `.env`; `GROQ_MODEL` can override the default model. No live Groq request is made by the tests. The context compactor below requests summaries when its token threshold is reached, once the application calls it; no API or agent entry point invokes it automatically yet.

`ConversationContextCompactor.build` assembles a model-ready prompt from the system prompt, latest saved summary, and recent exact messages. It counts the full prompt with the GPT-OSS-120B tokenizer. At 80% of the configured input budget, it summarizes older messages in bounded batches and retains the newest message in the prompt. The source transcript is not edited. The default target is 65% of the input budget, with up to two summary calls per build; configure the input budget for the agent and reserve response tokens separately.

The caller can create it with `new ConversationContextCompactor(episodicMemory, summaryService, { inputTokenBudget: 12_000 })` and pass the returned `messages` to the model. An unusually large newest message fails with `ContextBudgetExceededError` instead of being silently truncated. The build also limits a single un-compacted transcript load to 1,000 messages.

Run the PostgreSQL integration test with:

```sh
npm run test:episodic
```

## Semantic memory

`SemanticMemoryStore` saves one durable fact per record in PostgreSQL. Each record has a stable semantic-memory ID, tenant/user ownership, a category, and references to the source conversation and exact message. Fetching by ID returns the stored fact together with its source message, scoped to the owning tenant and user. Superseding a fact creates a new record and retains the prior one with a `superseded` status.

`GroqSemanticFactExtractor` proposes fact candidates from caller-supplied, ID-tagged user/assistant messages. When given a `SemanticMemoryVectorStore`, `AutomaticSemanticMemoryService` retrieves up to five similar active facts for the same tenant/user and asks Groq to classify each candidate as `same`, `new`, `update`, or `uncertain`. Same and uncertain candidates are skipped. New facts are saved; updates supersede the matched PostgreSQL fact and refresh Qdrant status. The service also skips unsupported-source, vague confirmation-only, and duplicate-in-batch candidates. The caller must supply messages already persisted in the same conversation so source-message IDs can be verified. This flow is an explicit application call; it is not attached to every conversation turn yet.

PostgreSQL is the canonical record for fact content and provenance. `SemanticMemoryVectorStore` creates local embeddings with FastEmbed, stores them in Qdrant under the semantic-memory ID, and scopes similarity search by tenant, user, and active status. Search returns IDs and scores; callers load and verify fact content in PostgreSQL. Pass a `SemanticMemoryVectorStore` as the third dependency to `AutomaticSemanticMemoryService`; it uses Groq for comparisons by default. Start the local Qdrant container with `npm run qdrant:up`; configure `QDRANT_URL` and `QDRANT_COLLECTION` in `.env`. The first embedding request downloads the FastEmbed model into the ignored `local_cache/` directory and runs it locally. Apply PostgreSQL migrations with `npm run db:migrate` and run the PostgreSQL integration tests with `npm run test:episodic`.

`ConversationPromptBuilder` connects retrieval to prompt assembly. After the latest user message has been saved to the conversation, the caller passes its text, the conversation scope/ID, and the system prompt. The builder retrieves relevant memories, adds them as labeled JSON reference data, and calls `ConversationContextCompactor` so the full prompt—including the memory block—is counted against the token budget. Its `messages` can be sent to the model provider. Retrieval remains an explicit caller step; it is not automatically run on every turn.

```ts
const prompt = await conversationPromptBuilder.build(
  conversationScope,
  conversationId,
  systemPrompt,
  latestUserMessage.content,
);
// Send prompt.messages to the model provider.
```

## Redis working memory

Start Redis on `127.0.0.1:6379`, then run the demo:

```sh
npm run demo
```

Set `REDIS_URL` to use another Redis address. Run its integration tests with `npm test`.
