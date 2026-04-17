/**
 * Run manifest — the structured output of a complete pipeline execution.
 *
 * Contains everything needed to understand what happened: which products,
 * which strategies, which providers, what cost, what passed/failed.
 * Written to output/run-<id>/manifest.json at the end of each run.
 */

import type { ProductVariants } from './creative.js';

export interface RunManifest {
  runId: string;
  briefFile: string;                    // path to the source brief
  startedAt: string;                    // ISO 8601
  finishedAt: string;
  durationMs: number;

  // Provider info — what was used for this run
  providers: {
    llm: string;                        // e.g., "gemini-2.5-flash"
    imageGenerator: string;             // e.g., "imagen-4.0-fast"
    storage: string;                    // e.g., "local-fs" or "azure-blob"
    embedding: string;                  // e.g., "gemini-embedding-001"
  };

  // Brand assets used (with integrity hashes for traceability)
  brandAssetsUsed: {
    logo: { path: string; sha256: string };
    palette: string[];
    fonts?: { display?: string; body?: string };
  };

  // Per-product results
  products: ProductVariants[];

  // Aggregate cost tracking
  costSummary: {
    totalUsdEst: number;
    byAgent: Record<string, number>;    // agent name → total cost
    byProduct: Record<string, number>;  // product id → total cost
    byProvider: Record<string, number>; // provider name → total cost
  };

  // Aggregate stats
  stats: {
    totalProducts: number;
    totalCreatives: number;
    totalGenerations: number;           // how many hero images were generated (vs reused)
    totalRetries: number;
    brandChecksPassed: number;
    brandChecksFailed: number;
    legalChecksClear: number;
    legalChecksFlagged: number;
  };
}
