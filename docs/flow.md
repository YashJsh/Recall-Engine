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
4. **Retrieve episodes** (`src/episode-retrieval.ts`): the top 3 episodes with similarity ≥ 0.6, from the Qdrant `episodes` collection, then verified in Postgres.
5. **Build the prompt** (`src/conversation-prompt-builder.ts`): system prompt + retrieved facts + dated episodes + history + the new message.

## Step 2: the host app calls its own LLM (`examples/next-demo/lib/chat-handler.ts`)
- The system prompt also includes the **working-memory notes** from Redis.
- The model may call these tools:
  - `save_temporary_note` writes a note to Redis (30-minute expiry). This is the **only** way anything reaches working memory.
  - `clear_temporary_notes` clears the notes, only when the user explicitly asks.
- The model writes its answer.

## Step 3: `completeTurn` (after the AI answers)
1. **Save the assistant message** to Postgres (transcript).
2. **Extract** (`src/semantic-fact-extractor.ts`):
   - Send the newest user message as the target, plus up to 4 earlier messages as context and today's date, to the Groq LLM.
   - It returns `{content, category, kind, durability, occurredAt, sourceMessageId}` for each candidate.
   - Routing:
     - `kind = fact` with durability ≥ 0.7 goes on to the steps below (semantic memory).
     - `kind = event` with durability ≥ 0.3 is saved as an **event episode**.
     - Everything else is skipped.
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
| Episodic, events (Postgres + Qdrant) | extractor | every turn with an event |

## Known gaps
- **No conversation episodes yet.** Summarizing finished conversations was removed for now; only events become episodes.
- **Date-range questions** ("what happened last week?") rely on relevance search only; there is no date filter.
- **Working memory depends on the chat model choosing to call a tool.**

## Routing

| kind | Destination |
|---|---|
| `fact` | semantic memory |
| `event` | episodic memory (event episode, with `occurredAt`) |
| `task` | dropped (working memory routing not built yet) |
| `request` | dropped |
