# Recall Engine

Recall Engine is being built incrementally as reusable memory infrastructure for AI agents.

## Current slices

- Redis-backed working memory with token budgets, priority eviction, protected items, and session TTL.
- PostgreSQL episodic memory for tenant-scoped sessions, conversations, and exact message history.

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

Run the PostgreSQL integration test with:

```sh
npm run test:episodic
```

## Redis working memory

Start Redis on `127.0.0.1:6379`, then run the demo:

```sh
npm run demo
```

Set `REDIS_URL` to use another Redis address. Run its integration tests with `npm test`.
