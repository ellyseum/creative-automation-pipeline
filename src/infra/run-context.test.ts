/**
 * RunContext cost-isolation test.
 *
 * Regression test for the bug fixed by introducing AsyncLocalStorage:
 * two overlapping ctx.invoke() calls used to both snapshot the same
 * adapters.llm.totalCostUsd before+after, double-counting the combined
 * delta. Now each invocation has its own per-scope accumulator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunContext, type Agent, type Adapters } from './run-context.js';
import { Logger } from './logger.js';
import { AuditWriter } from './audit-writer.js';
import { CostTracker } from './cost-tracker.js';
import { recordInvocationLlmCost } from './invocation-scope.js';

// Minimal mock adapters. Only `llm.name` and `llm.totalCostUsd` are read by
// RunContext; everything else is stubbed with enough shape to satisfy the type.
function makeAdapters(): Adapters {
  return {
    llm: { name: 'mock-llm', totalCostUsd: 0 } as unknown as Adapters['llm'],
    multimodal: {} as Adapters['multimodal'],
    embedding: {} as Adapters['embedding'],
    imageGen: { name: 'mock-imagegen' } as unknown as Adapters['imageGen'],
    storage: { name: 'mock-storage' } as unknown as Adapters['storage'],
    assetIndex: { name: 'mock-index' } as unknown as Adapters['assetIndex'],
  };
}

// Agent that simulates an LLM call: reports `cost` to the current invocation
// scope after a short delay. Two concurrent invocations of this agent should
// each attribute only their own cost.
class MockAgent implements Agent<{ cost: number; delayMs: number }, { done: true }> {
  readonly name = 'mock-agent';
  async execute(input: { cost: number; delayMs: number }): Promise<{ done: true }> {
    await new Promise((r) => setTimeout(r, input.delayMs));
    recordInvocationLlmCost(input.cost);
    return { done: true };
  }
}

describe('RunContext cost isolation under concurrency', () => {
  let tmpDir: string;
  let ctx: RunContext;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'runctx-test-'));
    ctx = new RunContext({
      runId: 'test-run',
      outputDir: tmpDir,
      logger: new Logger('error'), // quiet
      audit: new AuditWriter(tmpDir),
      costs: new CostTracker(),
      adapters: makeAdapters(),
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('attributes only per-invocation LLM cost even when invocations overlap', async () => {
    const agent = new MockAgent();

    // Two concurrent invocations with different costs and staggered timing
    // so they genuinely overlap (both are in-flight at the same moment).
    await Promise.all([
      ctx.invoke(agent, { cost: 0.01, delayMs: 20 }, { productId: 'p1' }),
      ctx.invoke(agent, { cost: 0.05, delayMs: 10 }, { productId: 'p2' }),
    ]);

    const summary = ctx.costs.summary();
    // Each product attributed exactly its own cost — no doubling, no bleed.
    expect(summary.byProduct['p1']).toBeCloseTo(0.01, 6);
    expect(summary.byProduct['p2']).toBeCloseTo(0.05, 6);
    expect(summary.totalUsdEst).toBeCloseTo(0.06, 6);
  });

  it('does not attribute cost to invocations that made no LLM calls', async () => {
    class NoopAgent implements Agent<unknown, { ok: true }> {
      readonly name = 'noop';
      async execute(): Promise<{ ok: true }> {
        return { ok: true };
      }
    }

    await ctx.invoke(new NoopAgent(), {}, { productId: 'p1' });
    const summary = ctx.costs.summary();
    expect(summary.totalUsdEst).toBe(0);
    expect(Object.keys(summary.byAgent)).toHaveLength(0);
  });
});
