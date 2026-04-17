/**
 * Retry utility tests — verifies backoff shape and retryable predicate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, defaultIsRetryable } from './retry.js';

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result on first success without sleeping', async () => {
    const fn = vi.fn(async () => 'ok');
    const p = withRetry(fn);
    await vi.runAllTimersAsync();
    expect(await p).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
      return 'ok';
    });
    const onRetry = vi.fn();
    const p = withRetry(fn, { baseDelayMs: 100, onRetry });

    await vi.runAllTimersAsync();
    expect(await p).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // First retry uses baseDelayMs * 2^0 = 100ms ± 20%
    const [attempt, delayMs] = onRetry.mock.calls[0];
    expect(attempt).toBe(1);
    expect(delayMs).toBeGreaterThanOrEqual(80);
    expect(delayMs).toBeLessThanOrEqual(120);
  });

  it('throws non-retryable errors immediately', async () => {
    const err = Object.assign(new Error('bad request'), { status: 400 });
    const fn = vi.fn(async () => {
      throw err;
    });
    const p = withRetry(fn, { maxRetries: 3 });
    await expect(p).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const err = Object.assign(new Error('still rate limited'), { status: 429 });
    const fn = vi.fn(async () => {
      throw err;
    });
    const p = withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });
    // Attach a rejection handler synchronously so draining fake timers
    // doesn't trip an unhandled-rejection warning.
    const assertion = expect(p).rejects.toBe(err);

    await vi.runAllTimersAsync();
    await assertion;
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects custom isRetryable predicate', async () => {
    const err = Object.assign(new Error('custom'), { kind: 'transient' });
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw err;
      return 'ok';
    });
    const p = withRetry(fn, {
      baseDelayMs: 1,
      isRetryable: (e) => (e as { kind?: string }).kind === 'transient',
    });
    await vi.runAllTimersAsync();
    expect(await p).toBe('ok');
  });
});

describe('defaultIsRetryable', () => {
  it('retries on 429, 503, 502, 504', () => {
    for (const status of [429, 503, 502, 504]) {
      expect(defaultIsRetryable({ status })).toBe(true);
    }
  });

  it('does not retry on 400 or 401', () => {
    expect(defaultIsRetryable({ status: 400 })).toBe(false);
    expect(defaultIsRetryable({ status: 401 })).toBe(false);
  });

  it('retries on transient socket errors', () => {
    expect(defaultIsRetryable({ code: 'ECONNRESET' })).toBe(true);
    expect(defaultIsRetryable({ code: 'ETIMEDOUT' })).toBe(true);
    expect(defaultIsRetryable({ code: 'ENOTFOUND' })).toBe(true);
  });

  it('handles numeric `code` status', () => {
    expect(defaultIsRetryable({ code: 429 })).toBe(true);
    expect(defaultIsRetryable({ code: 200 })).toBe(false);
  });

  it('returns false for null/undefined/primitive inputs', () => {
    expect(defaultIsRetryable(null)).toBe(false);
    expect(defaultIsRetryable(undefined)).toBe(false);
    expect(defaultIsRetryable('boom')).toBe(false);
  });

  it('retries TypeError: fetch failed from Node undici', () => {
    const err = new TypeError('fetch failed');
    expect(defaultIsRetryable(err)).toBe(true);
  });

  it('drills into err.cause to find retryable network errors', () => {
    const err = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    });
    expect(defaultIsRetryable(err)).toBe(true);
  });

  it('drills into AggregateError.errors[]', () => {
    const err = Object.assign(new Error('all attempts failed'), {
      errors: [{ code: 'ENOTFOUND' }, { code: 'EAI_AGAIN' }],
    });
    expect(defaultIsRetryable(err)).toBe(true);
  });

  it('retries common undici error codes', () => {
    expect(defaultIsRetryable({ code: 'UND_ERR_SOCKET' })).toBe(true);
    expect(defaultIsRetryable({ code: 'UND_ERR_CONNECT_TIMEOUT' })).toBe(true);
    expect(defaultIsRetryable({ code: 'ECONNREFUSED' })).toBe(true);
  });

  it('does not infinite-loop on cyclic cause chains', () => {
    const a: { cause?: unknown; code?: string } = {};
    const b: { cause?: unknown; code?: string } = { cause: a };
    a.cause = b;
    // Neither has a retryable code — depth guard prevents stack overflow
    expect(defaultIsRetryable(a)).toBe(false);
  });
});
