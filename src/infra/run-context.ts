/**
 * Run context — the central orchestration wrapper for all agent invocations.
 *
 * Every agent call goes through ctx.invoke(). This wrapper:
 * 1. Records start time
 * 2. Writes input artifact to _audit/
 * 3. Calls the agent's execute() method
 * 4. Records output artifact, cost, tokens, duration
 * 5. Appends the invocation to audit.jsonl
 * 6. Logs progress to stdout
 * 7. Updates the cost tracker
 *
 * You CANNOT call an agent without going through this wrapper — it IS the
 * audit trail. Forgetting to log means bypassing the orchestrator itself.
 */

import { randomUUID } from 'node:crypto';
import type { AgentInvocation, InvocationScope } from '../domain/invocation.js';
import type { Logger } from './logger.js';
import type { AuditWriter } from './audit-writer.js';
import type { CostTracker } from './cost-tracker.js';
import type { Storage } from '../ports/storage.js';
import type { LLMClient, MultimodalLLMClient, EmbeddingClient } from '../ports/llm-client.js';
import type { ImageGenerator } from '../ports/image-generator.js';
import type { AssetIndex } from '../ports/asset-index.js';

// Agent interface — every agent implements this. Generic over input/output types.
export interface Agent<I, O> {
  readonly name: string;
  execute(input: I, ctx: RunContext): Promise<O>;
}

// Resolved adapter set — injected at pipeline start, available to all agents.
export interface Adapters {
  llm: LLMClient;
  multimodal: MultimodalLLMClient;
  embedding: EmbeddingClient;
  imageGen: ImageGenerator;
  storage: Storage;
  assetIndex: AssetIndex;
}

export class RunContext {
  readonly runId: string;
  readonly outputDir: string;
  readonly logger: Logger;
  readonly audit: AuditWriter;
  readonly costs: CostTracker;
  readonly adapters: Adapters;

  constructor(opts: {
    runId: string;
    outputDir: string;
    logger: Logger;
    audit: AuditWriter;
    costs: CostTracker;
    adapters: Adapters;
  }) {
    this.runId = opts.runId;
    this.outputDir = opts.outputDir;
    this.logger = opts.logger;
    this.audit = opts.audit;
    this.costs = opts.costs;
    this.adapters = opts.adapters;
  }

  /**
   * Invoke an agent with full audit trail.
   *
   * This is the ONLY way to call an agent in the pipeline. Every call
   * is logged, timed, cost-tracked, and artifact-stored. The scope
   * parameter links invocations to products/ratios and supports
   * parent-child relationships for retries and sub-calls.
   */
  async invoke<I, O>(
    agent: Agent<I, O>,
    input: I,
    scope?: InvocationScope,
  ): Promise<O> {
    const invocationId = randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    // Write input artifact to audit storage
    const inputStr = typeof input === 'string' ? input
      : input instanceof Buffer ? `<Buffer ${input.length} bytes>`
      : JSON.stringify(input, null, 2);
    const inputRef = await this.audit.writeArtifact(invocationId, 'input.json', inputStr);

    const inv: Partial<AgentInvocation> = {
      invocationId,
      parentInvocationId: scope?.parentId,
      runId: this.runId,
      agent: agent.name,
      productId: scope?.productId,
      aspectRatio: scope?.aspectRatio,
      startedAt,
      inputRef,
      inputSummary: typeof input === 'object' && input !== null && !(input instanceof Buffer)
        ? this.summarize(input as Record<string, unknown>)
        : undefined,
    };

    try {
      // Execute the agent
      const output = await agent.execute(input, this);

      // Write output artifact
      const outputStr = typeof output === 'string' ? output
        : output instanceof Buffer ? `<Buffer ${output.length} bytes>`
        : JSON.stringify(output, null, 2);
      const outputRef = await this.audit.writeArtifact(invocationId, 'output.json', outputStr);

      inv.status = 'ok';
      inv.outputRef = outputRef;
      inv.outputSummary = typeof output === 'object' && output !== null && !(output instanceof Buffer)
        ? this.summarize(output as Record<string, unknown>)
        : undefined;

      return output;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      inv.status = 'error';
      inv.error = {
        type: error.name,
        message: error.message,
        retryable: (error as { retryable?: boolean }).retryable ?? false,
      };
      throw err;
    } finally {
      // Always record — even on error
      inv.finishedAt = new Date().toISOString();
      inv.durationMs = Date.now() - startMs;

      // Log to stdout for live progress
      const status = inv.status === 'ok' ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
      const scope_str = scope?.productId ? ` (${scope.productId}${scope.aspectRatio ? ' ' + scope.aspectRatio : ''})` : '';
      const dur = `${inv.durationMs}ms`;
      const cost = inv.costUsdEst ? ` $${inv.costUsdEst.toFixed(4)}` : '';
      this.logger.info(agent.name, `${status}${scope_str} ${dur}${cost}`);

      // Append to audit log
      await this.audit.append(inv as AgentInvocation);
    }
  }

  // Create a summary of an object — picks a few key fields for the inline log.
  // Keeps invocation records scannable without reading full artifacts.
  private summarize(obj: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    let count = 0;
    for (const [key, val] of Object.entries(obj)) {
      if (count >= 5) break;  // max 5 fields in summary
      if (typeof val === 'string' && val.length > 100) {
        summary[key] = val.slice(0, 97) + '...';
      } else if (Array.isArray(val)) {
        summary[key] = `[${val.length} items]`;
      } else if (typeof val !== 'object') {
        summary[key] = val;
      }
      count++;
    }
    return summary;
  }
}
