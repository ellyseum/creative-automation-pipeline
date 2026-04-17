/**
 * Embedder agent — thin wrapper around the embedding adapter.
 *
 * Exists so every vector-embedding call gets its own audit entry and
 * invocation-scoped cost line. Without this, embed() was called directly
 * on the adapter from buildAssetIndex and its cost was silently rolled
 * into the parent asset-analyzer invocation, making per-call attribution
 * invisible in the manifest's cost breakdown.
 *
 * The agent is deliberately minimal — just the right "shape" to flow
 * through ctx.invoke()'s audit trail. No prompting, no LLM calls.
 */

import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';

export interface EmbedderInput {
  // Text to embed — typically an asset description for RAG retrieval.
  text: string;
  // Optional embedding dimensionality override (adapter default is 768).
  dimensions?: number;
}

export interface EmbedderOutput {
  // The resulting embedding vector.
  vector: number[];
  // Number of dimensions — convenience for the manifest/audit.
  dims: number;
}

export class EmbedderAgent implements Agent<EmbedderInput, EmbedderOutput> {
  readonly name = 'embedder';

  async execute(input: EmbedderInput, ctx: RunContext): Promise<EmbedderOutput> {
    const vector = await ctx.adapters.embedding.embed(input.text, { dimensions: input.dimensions });
    return { vector, dims: vector.length };
  }
}
