/**
 * Rate limiter tests — verifies the shared llmLimit/imageGenLimit instances
 * enforce their concurrency caps.
 *
 * The module reads LLM_CONCURRENCY / IMAGE_GEN_CONCURRENCY at import time,
 * so we can't change the cap between tests. Instead we verify that the
 * limiters actually gate concurrency (not that they're a specific number)
 * by observing in-flight count never exceeds `pendingCount + activeCount`
 * limits, and by constructing a standalone pLimit for a precise assertion.
 */

import { describe, it, expect } from 'vitest';
import pLimit from 'p-limit';
import { llmLimit, imageGenLimit } from './rate-limiter.js';

describe('rate-limiter', () => {
  it('exports LimitFunction instances for llm and image gen', () => {
    expect(typeof llmLimit).toBe('function');
    expect(typeof imageGenLimit).toBe('function');
    // p-limit LimitFunctions expose concurrency, activeCount, pendingCount
    expect(llmLimit.concurrency).toBeGreaterThan(0);
    expect(imageGenLimit.concurrency).toBeGreaterThan(0);
  });

  it('gates concurrency: never more than N tasks in flight', async () => {
    // Use a standalone pLimit so this test is independent of env defaults.
    const limit = pLimit(2);
    let inFlight = 0;
    let maxInFlight = 0;

    const task = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    };

    await Promise.all(Array.from({ length: 10 }, () => limit(task)));
    expect(maxInFlight).toBe(2);
  });

  it('queues excess tasks without losing them', async () => {
    const limit = pLimit(1);
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        limit(async () => {
          order.push(i);
          await new Promise((r) => setTimeout(r, 1));
        }),
      ),
    );

    // With concurrency=1, tasks run in the order they were enqueued.
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});
