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

`saveSummary` stores supplied summary text as a versioned checkpoint through a message sequence number. Earlier versions are retained. `ConversationSummaryService` selects only messages after the previous checkpoint and through the requested sequence, asks a provider-neutral `SummaryGenerator` to summarize them, then persists the result. The current `GroqSummaryGenerator` uses Groq's chat-completions API. Set `GROQ_API_KEY` in your local `.env`; `GROQ_MODEL` can override the default model. Tests use provider stubs or verify the missing-key path; they do not make live Groq requests. The context compactor requests summaries when its token threshold is reached; the public conversation turn API invokes it during turn preparation.

`ConversationContextCompactor.build` assembles a model-ready prompt from the system prompt, latest saved summary, and recent exact messages. It counts the full prompt with the GPT-OSS-120B tokenizer. At 80% of the configured input budget, it summarizes older messages in bounded batches and retains the newest message in the prompt. The source transcript is not edited. The default target is 65% of the input budget, with up to two summary calls per build; configure the input budget for the agent and reserve response tokens separately. The public API defaults this budget to 12,000 tokens, configurable with `RECALL_CONTEXT_INPUT_TOKEN_BUDGET`.

The caller can create it with `new ConversationContextCompactor(episodicMemory, summaryService, { inputTokenBudget: 12_000 })` and pass the returned `messages` to the model. An unusually large newest message fails with `ContextBudgetExceededError` instead of being silently truncated. The build also limits a single un-compacted transcript load to 1,000 messages.

Run the PostgreSQL integration test with:

```sh
npm run test:episodic
```

## Semantic memory

`SemanticMemoryStore` saves one durable fact per record in PostgreSQL. Each record has a stable semantic-memory ID, tenant/user ownership, a category, and references to the source conversation and exact message. Fetching by ID returns the stored fact together with its source message, scoped to the owning tenant and user. Superseding a fact creates a new record and retains the prior one with a `superseded` status.

`GroqSemanticFactExtractor` proposes fact candidates from caller-supplied, ID-tagged user/assistant messages. When given a `SemanticMemoryVectorStore`, `AutomaticSemanticMemoryService` retrieves up to five similar active facts for the same tenant/user and asks Groq to classify each candidate as `same`, `new`, `update`, or `uncertain`. Same and uncertain candidates are skipped. New facts are saved; updates supersede the matched PostgreSQL fact and refresh Qdrant status. The service also skips unsupported-source, vague confirmation-only, and duplicate-in-batch candidates. The caller must supply messages already persisted in the same conversation so source-message IDs can be verified. The public turn API attempts this flow after saving each assistant response and reports extraction failures separately.

PostgreSQL is the canonical record for fact content and provenance. `SemanticMemoryVectorStore` creates local embeddings with FastEmbed, stores them in Qdrant under the semantic-memory ID, and scopes similarity search by tenant, user, and active status. Search returns IDs and scores; callers load and verify fact content in PostgreSQL. Pass a `SemanticMemoryVectorStore` as the third dependency to `AutomaticSemanticMemoryService`; it uses Groq for comparisons by default. Start the local Qdrant container with `npm run qdrant:up`; configure `QDRANT_URL` and `QDRANT_COLLECTION` in `.env`. The first embedding request downloads the FastEmbed model into the ignored `local_cache/` directory and runs it locally. Apply PostgreSQL migrations with `npm run db:migrate` and run the PostgreSQL integration tests with `npm run test:episodic`.

`ConversationPromptBuilder` connects retrieval to prompt assembly. After the latest user message has been saved to the conversation, the caller passes its text, the conversation scope/ID, and the system prompt. The builder retrieves relevant memories, adds them as labeled JSON reference data, and calls `ConversationContextCompactor` so the full prompt—including the memory block—is counted against the token budget. Its `messages` can be sent to the model provider. The public turn API invokes this retrieval as part of turn preparation.

```ts
const prompt = await conversationPromptBuilder.build(
  conversationScope,
  conversationId,
  systemPrompt,
  latestUserMessage.content,
);
// Send prompt.messages to the model provider.
```

`ConversationTurnMemoryService` provides the memory lifecycle around a host application's model call. `prepareTurn` saves the user message and returns the assembled prompt. The consuming app sends `prepared.prompt.messages` to its own model, then passes the response to `completeTurn`. Recall Engine saves the assistant message and attempts semantic fact extraction using up to eight persisted messages ending at the current user message. The newly generated assistant response is saved in the transcript but is not used as evidence for facts from that turn. An assistant reply is accepted only if the conversation has not advanced since that user message was prepared, preventing overlapping turns from being stored out of order. If extraction fails, `completeTurn` still returns the saved assistant response with a failed memory outcome. Groq is used internally for summaries, extraction, and fact comparison; the consuming application owns the conversational model call.

```ts
const prepared = await conversationMemory.prepareTurn(
  conversationScope,
  conversationId,
  systemPrompt,
  userMessage,
);
const assistantText = await yourModel.complete(prepared.prompt.messages);
const completed = await conversationMemory.completeTurn(
  conversationScope,
  prepared,
  assistantText,
);
return completed.assistantMessage.content;
```

## Public library API

Applications can use the supported API from the package entry point. `connectRecallEngine()` reads the environment settings, connects to PostgreSQL, Redis, and Qdrant, and returns grouped conversation, working-memory, and semantic-memory operations. Keep one instance for the lifetime of the host application and call `close()` during graceful shutdown; do not connect and close on every turn.

```ts
import { connectRecallEngine } from "recall-engine";

const recall = await connectRecallEngine();

const conversation = await recall.conversations.create(scope);
const prepared = await recall.conversations.prepareTurn({
  scope,
  conversationId: conversation.id,
  systemPrompt,
  userMessage,
});

// Call the host application's model with prepared.prompt.messages.
const assistantContent = await hostModel.complete(prepared.prompt.messages);
const completed = await recall.conversations.completeTurn({
  scope,
  preparedTurn: prepared,
  assistantContent,
});

// On application shutdown:
await recall.close();
```

Startup checks that PostgreSQL, Redis, and Qdrant are reachable. The configured Qdrant collection is created on the first semantic index/search operation if it does not already exist. FastEmbed initializes only when semantic search or indexing needs an embedding. Groq is also initialized when a memory summary or extraction is first requested; extraction failures are returned separately from the saved assistant response.

Turn preparation saves the user message before building its prompt. If retrieval or compaction then fails, `ConversationPromptPreparationError` includes the saved message ID. The application can retry preparation with the same scope, conversation, and text plus `resumeUserMessageId`; Recall Engine verifies that message and checks that no later conversation message has been added before rebuilding the prompt. This avoids silently adding the same user message twice.

`DATABASE_URL` is required. `REDIS_URL`, `QDRANT_URL`, `QDRANT_COLLECTION`, `GROQ_API_KEY`, and `GROQ_MODEL` use their documented defaults/environment settings. Context and working-memory limits can be set with `RECALL_CONTEXT_INPUT_TOKEN_BUDGET`, `RECALL_WORKING_MEMORY_TOKEN_BUDGET`, and `RECALL_WORKING_MEMORY_SESSION_TTL_MS`; the defaults are 12,000 input tokens, 4,000 working-memory tokens, and a 30-minute session TTL. `connectRecallEngine` also accepts connection URLs and these limits as options. The semantic-memory group supports direct fact storage with a source message, lookup by ID, scoped retrieval, and explicit extraction for workflows outside the automatic turn flow.

## Redis working memory

Start Redis on `127.0.0.1:6379`, then run the demo:

```sh
npm run demo
```

Set `REDIS_URL` to use another Redis address. Run its integration tests with `npm test`.
