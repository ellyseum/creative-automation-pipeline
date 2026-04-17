/**
 * Async-scoped per-invocation cost accumulator.
 *
 * Why this exists: the previous implementation read `adapters.llm.totalCostUsd`
 * before an agent ran and diffed against it after. Under concurrency that
 * double-counts — two overlapping invocations both observe the same `before`
 * and `after`, each attributing the combined delta.
 *
 * AsyncLocalStorage binds a mutable accumulator to the async-call tree under
 * `run()`. The Gemini adapter (and any other LLM adapter) adds its cost both
 * to the global `totalCostUsd` (for the end-of-run total, which remains
 * correct because every cost is still counted once) AND to the current
 * invocation's accumulator when one is active.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface InvocationCosts {
  llmUsd: number;
}

export const invocationStorage = new AsyncLocalStorage<InvocationCosts>();

// Called by LLM adapters on each priced call. No-op when not in an invocation
// (e.g., pipeline-level embedding warmup outside ctx.invoke).
export function recordInvocationLlmCost(costUsd: number): void {
  const store = invocationStorage.getStore();
  if (store) store.llmUsd += costUsd;
}
