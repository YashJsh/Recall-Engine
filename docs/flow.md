# Current flow (one chat turn)

## Step 1: `prepareTurn` (before the AI answers)
1. **Save the user message** to Postgres `ConversationMessage` (transcript).
2. **Build the chat history** (`src/context-compaction.ts`):
   - Load this conversation's messages.
   - If the total is over 12k tokens, summarize the oldest messages into a `ConversationSummary` and keep the rest verbatim.
   - Otherwise send everything verbatim. Short chats therefore never get a summary.
3. **Retrieve semantic facts** (`src/semantic-memory-retrieval.ts`):
   - Embed the user message and search Qdrant.
   - Keep the top 5 with similarity ≥ 0.5, then load their text from Postgres.
4. **Build the prompt** (`src/conversation-prompt-builder.ts`): system prompt + retrieved facts + history + the new message.

## Step 2: the host app calls its own LLM (`examples/next-demo/lib/chat-handler.ts`)
- The system prompt also includes the **working-memory notes** from Redis.
- The model may call these tools:
  - `save_temporary_note` writes a note to Redis (30-minute expiry). This is the **only** way anything reaches working memory.
  - `clear_temporary_notes` clears the notes, only when the user explicitly asks.
- The model writes its answer.

## Step 3: `completeTurn` (after the AI answers)
1. **Save the assistant message** to Postgres (transcript).
2. **Extract facts** (`src/semantic-fact-extractor.ts`):
   - Send the last 8 messages to the Groq LLM.
   - It returns `{content, category, sourceMessageId}` for each fact.
3. **Compare** each fact with similar existing ones (`src/semantic-fact-comparator.ts`). The result is one of:
   - skip: a duplicate
   - save new
   - supersede: replace the old fact
4. **Save** to Postgres `SemanticMemory` and index it in Qdrant.

## Where each layer gets written

| Layer | Written by | When |
|---|---|---|
| Working (Redis) | the chat model's tool call | only if the model chooses to |
| Transcript messages (Postgres) | prepareTurn / completeTurn | every turn |
| Compaction summaries (Postgres) | compactor | only when history is over 12k tokens |
| Semantic (Postgres + Qdrant) | extractor | every turn |

## Known gaps
- **Semantic memory has no "worth remembering?" check.** One-off requests ("give me a fun fact today"), events ("won a marathon yesterday") and task state ("remember this URL for my current task") all get saved as facts.
- **The extractor re-reads the last 8 messages every turn**, so each message is extracted up to ~4 times. Only the dedup step prevents duplicates.
- **Episodic memory does not exist yet** (see ADR 0002). Stored messages are the transcript; compaction summaries only shorten the current chat.
- **Working memory depends on the chat model choosing to call a tool.**

## Routing (not built yet)
Today the extractor has one output: semantic facts. Routing would have the extractor label each item with a `kind`, and code would send it to the right layer:

| kind | Destination |
|---|---|
| `fact` | semantic memory |
| `event` | episodic memory (with an absolute date) |
| `task` | working memory |
| `request` | dropped |

Until episodic and working memory can receive these items, only `kind = fact` is saved and the rest are dropped.
