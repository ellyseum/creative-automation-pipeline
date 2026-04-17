/**
 * Process-wide concurrency limiters for outbound API calls.
 *
 * Module-scoped so that all RunContexts in the same Node process share one
 * limiter per resource — this matters for the webserver, which allows
 * multiple pipeline jobs to run concurrently. Without a shared limiter,
 * two jobs × four in-flight calls each = eight concurrent Gemini calls
 * against a 15 RPM free-tier budget.
 *
 * LLM and image-gen get separate pools because image generation is slower
 * and rate-limited harder than text/vision LLM calls.
 *
 * Caps are tunable at process start via env vars. Defaults are conservative
 * enough for the Gemini free tier with modest concurrency headroom.
 */

import pLimit, { type LimitFunction } from 'p-limit';

const DEFAULT_LLM_CONCURRENCY = 4;
const DEFAULT_IMAGE_GEN_CONCURRENCY = 2;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Wraps text completions, vision analysis, and embedding calls.
export const llmLimit: LimitFunction = pLimit(readEnvInt('LLM_CONCURRENCY', DEFAULT_LLM_CONCURRENCY));

// Wraps hero image generation (Imagen, Firefly).
export const imageGenLimit: LimitFunction = pLimit(readEnvInt('IMAGE_GEN_CONCURRENCY', DEFAULT_IMAGE_GEN_CONCURRENCY));
