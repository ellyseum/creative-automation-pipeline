/**
 * Environment variable helpers — centralized config loading.
 *
 * dotenv loads .env from project root if present (silent skip if missing).
 * must() throws immediately if a required var is missing — fail-fast on startup,
 * not halfway through a pipeline run. optional() returns undefined silently.
 */

import 'dotenv/config'; // side-effect: loads .env into process.env

// Require an env var — throws with a clear message if missing.
// Used for vars that make the pipeline non-functional without (e.g., GEMINI_API_KEY).
export function must(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

// Optional env var with a default fallback.
export function optional(key: string, fallback?: string): string | undefined {
  return process.env[key] || fallback;
}

// Read a numeric env var with a default.
export function optionalInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}
