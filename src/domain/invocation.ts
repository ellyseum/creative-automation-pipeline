/**
 * Agent invocation envelope — the audit trail primitive.
 *
 * Every agent call is wrapped in this structure by the RunContext.invoke()
 * method. Written to audit.jsonl (one line per invocation) and used for:
 * - Cost attribution (which agent/product/provider drove spend)
 * - Failure forensics (what went in, what came out, why it retried)
 * - Replay (re-run a specific invocation with original inputs)
 * - Compliance (immutable, append-only record of all AI decisions)
 *
 * Inputs and outputs are stored as separate artifact files (not inline)
 * to keep log lines small. The invocation references them by path.
 */

export interface AgentInvocation {
  invocationId: string;           // uuid v7 (time-ordered for natural sort)
  parentInvocationId?: string;    // causality chain — retries and sub-calls point to parent
  runId: string;                  // groups all invocations in one pipeline execution
  agent: string;                  // agent name: "creative-director", "brand-auditor", etc.
  productId?: string;             // if scoped to a specific product
  aspectRatio?: string;           // if scoped to a specific variant
  startedAt: string;              // ISO 8601
  finishedAt: string;             // ISO 8601
  durationMs: number;
  status: 'ok' | 'retry' | 'error';

  // Artifact references — stored in _audit/<invocationId>/
  inputRef: string;               // path to input artifact (JSON or image)
  outputRef?: string;             // path to output artifact
  inputSummary?: Record<string, unknown>;   // small inline summary for quick scanning
  outputSummary?: Record<string, unknown>;

  // AI provider metadata
  model?: string;                 // e.g., "gemini-2.5-flash", "imagen-4.0-fast"
  provider?: string;              // e.g., "gemini", "imagen", "firefly"
  tokens?: { prompt: number; completion: number };
  costUsdEst?: number;

  // Error and retry info
  error?: { type: string; message: string; retryable: boolean };
  retryReason?: string;
  retryCount?: number;
}

// Scoping context for an invocation — passed to RunContext.invoke()
export interface InvocationScope {
  productId?: string;
  aspectRatio?: string;
  parentId?: string;              // links to parent invocation for sub-calls
}
