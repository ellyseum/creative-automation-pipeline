/**
 * Shared retry utility with exponential backoff + jitter.
 *
 * Extracted from the Gemini adapter so every outbound call (LLM, image gen,
 * embedding, storage) can opt in. Jitter matters once fan-out is on: without
 * it, a concurrent batch that all 429s together retries in lockstep and
 * re-triggers the rate limit. ±20% jitter spreads the retries.
 */

export interface RetryOptions {
  // Max additional attempts after the initial call. Default 3 → up to 4 calls total.
  maxRetries?: number;
  // Base delay in ms; actual delay is baseDelayMs * 2^attempt ± jitter.
  baseDelayMs?: number;
  // Predicate deciding whether to retry a given error. Defaults cover 429/503
  // HTTP errors and common transient network failures.
  isRetryable?: (err: unknown) => boolean;
  // Called on each retry, before sleeping. Useful for logging.
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  // Per-attempt timeout. If the underlying fn() doesn't settle within this
  // window, we reject with a TimeoutError (which defaultIsRetryable treats as
  // retryable). Critical for LLM calls: the @google/genai SDK has its own
  // internal retry on 503 with no external signal, so a hung primary model
  // can wait minutes before surfacing — a timeout forces us to surface and
  // fall back. 0 or undefined = no timeout.
  timeoutMs?: number;
}

// Marker class so callers can identify timeouts vs other errors, and so
// defaultIsRetryable can match them via instanceof without introspecting.
export class TimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

// Race fn() against a timeout. If the timeout wins, reject with TimeoutError
// and let the underlying fn run its course (it'll be GC'd when done).
export function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return fn();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Default: retry on HTTP 429/503 and common transient socket errors.
// Providers sometimes surface the status as `err.status`, sometimes `err.code`.
// Node's undici fetch wraps network errors in `TypeError: fetch failed` with
// the real cause on `err.cause` (possibly nested or inside an AggregateError),
// so we also drill into that chain.
export function defaultIsRetryable(err: unknown, depth = 0): boolean {
  if (err == null || typeof err !== 'object') return false;
  if (depth > 3) return false; // guard against cyclic cause chains

  const e = err as { status?: unknown; code?: unknown; cause?: unknown; errors?: unknown; message?: unknown };
  const status = typeof e.status === 'number' ? e.status : typeof e.status === 'string' ? parseInt(e.status, 10) : NaN;
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;

  const code = e.code;
  if (
    typeof code === 'string' &&
    (code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === 'ECONNREFUSED' ||
      code === 'EAI_AGAIN' ||
      code === 'UND_ERR_SOCKET' ||
      code === 'UND_ERR_CONNECT_TIMEOUT')
  )
    return true;
  if (typeof code === 'number' && (code === 429 || code === 503)) return true;

  // Our own TimeoutError — used to force fallback when a model hangs inside
  // the SDK (e.g., @google/genai silently internally-retrying on 503).
  if (err instanceof TimeoutError) return true;

  // `TypeError: fetch failed` — Node's undici wrapper. The real cause lives on
  // `.cause`. AggregateErrors (e.g., all IPv6/IPv4 attempts failed) use `.errors`.
  if (typeof e.message === 'string' && e.message === 'fetch failed') return true;
  if (e.cause && defaultIsRetryable(e.cause, depth + 1)) return true;
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) if (defaultIsRetryable(inner, depth + 1)) return true;
  }

  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const timeoutMs = opts.timeoutMs ?? 0;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return timeoutMs > 0 ? await withTimeout(fn, timeoutMs) : await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isRetryable(err)) throw err;

      // Exponential: 1s, 2s, 4s, 8s... then ±20% jitter so a concurrent batch
      // that 429s together doesn't re-hammer the API in lockstep.
      const expDelay = baseDelayMs * Math.pow(2, attempt);
      const jitter = expDelay * 0.2 * (Math.random() * 2 - 1);
      const delayMs = Math.max(0, Math.round(expDelay + jitter));

      opts.onRetry?.(attempt + 1, delayMs, err);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  // Unreachable: either we return inside the try or throw on the last attempt.
  throw lastErr;
}
