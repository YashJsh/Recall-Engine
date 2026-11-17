# Semantic Fact Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual Groq extractor that returns validated semantic fact candidates with source message IDs.

**Architecture:** A small extractor service takes ID-tagged conversation messages and calls Groq using strict JSON Schema output. It validates categories and verifies each cited source ID belongs to a user message. It returns proposals only; the caller chooses whether to persist them through the existing semantic memory store.

**Tech Stack:** TypeScript, Groq SDK, Node test runner, existing Prisma category enum.

**Spec:** `docs/superpowers/specs/2026-11-16-semantic-fact-extraction-design.md`

## File Structure

- Create `src/semantic-fact-extractor.ts` for public types, extraction prompt, Groq request, and output/source validation.
- Create `tests/semantic-fact-extractor.test.ts` for deterministic tests using an injectable completion seam or extracted response validator.
- Modify `tsconfig.episodic-test.json` and `package.json` only as needed to compile/run the focused test.
- Create `examples/semantic-fact-extraction-demo.ts` for a manually invoked live demo with synthetic messages; keep demo separate from source and tests.
- Modify `tsconfig.demo.json` and `package.json` to add a dedicated extractor demo script.
- Modify `IMPROVEMENTS.md` only if a concrete limitation is found during implementation or live evaluation.

## Task 1: Extract candidates and validate provenance

- [ ] Write a public-interface test: a valid candidate citing a user message is returned, while a candidate citing an assistant or unknown message is rejected.
- [ ] Run the focused test and confirm it fails because the extractor does not exist.
- [ ] Implement the smallest extractor seam with an injectable Groq client or response-validation boundary, strict structured output, explicit roles, and no database dependency.
- [ ] Run the focused test and confirm it passes.
- [ ] Add tests for empty candidates, unsupported categories, and malformed output one behavior at a time.
- [ ] Run focused semantic-memory and episodic tests.

## Task 2: Add a separate live demo

- [ ] Add a demo with synthetic user and assistant messages that exercise a reference such as “yes, the second one.”
- [ ] Add a dedicated `demo:semantic-extractor` script and TypeScript demo config inclusion.
- [ ] Run the demo with Groq and inspect that its candidate cites the source user-message ID; do not persist its result.
- [ ] Run `npm run check`, focused tests, and the demo build.

## Review focus

- Ensure context text is treated as untrusted input and assistant text is not accepted as fact evidence.
- Ensure candidates cannot cite message IDs outside the supplied context or cross role boundaries.
- Ensure fact text is standalone and contextual confirmations do not become vague or duplicate facts.
- Ensure the demo cannot write to PostgreSQL.
