import { connectRecallEngine, type RecallEngine } from "recall-engine";

type RecallRuntime = typeof globalThis & {
  __recallDemoEnginePromise?: Promise<RecallEngine>;
};

const recallRuntime = globalThis as RecallRuntime;

function readContextBudget(): number | undefined {
  const configured = process.env.DEMO_CONTEXT_INPUT_TOKEN_BUDGET;
  if (!configured?.trim()) return undefined;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("DEMO_CONTEXT_INPUT_TOKEN_BUDGET must be a positive integer");
  }
  return value;
}

/** Tokens held back from the context budget for tool schemas, tool calls, and tool results. */
const TOOL_LOOP_RESERVE_TOKENS = 2_000;

/** Reuses one managed connection for the lifetime of the local Next.js server. */
export function getRecallEngine(): Promise<RecallEngine> {
  if (!recallRuntime.__recallDemoEnginePromise) {
    const contextInputTokenBudget = readContextBudget();
    recallRuntime.__recallDemoEnginePromise = connectRecallEngine(
      contextInputTokenBudget === undefined
        ? {}
        : { contextInputTokenBudget: Math.max(1_000, contextInputTokenBudget - TOOL_LOOP_RESERVE_TOKENS) },
    );
  }
  return recallRuntime.__recallDemoEnginePromise;
}
