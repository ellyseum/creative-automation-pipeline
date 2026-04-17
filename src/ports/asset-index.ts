/**
 * Asset index port — vector search over the brand's asset library.
 *
 * The pipeline's RAG layer: assets are analyzed by the Asset Analyzer
 * (multimodal LLM → structured metadata), descriptions are embedded,
 * and the Creative Director searches them with natural-language queries.
 *
 * For the demo: JsonAssetIndex (in-memory cosine similarity over a
 * JSON file). For production: Azure AI Search, pgvector, Pinecone —
 * same interface, same query patterns.
 */

import type { IndexedAsset, AssetMatch } from '../domain/asset-metadata.js';

export interface AssetIndex {
  readonly name: string;

  // Load an existing index from persistent storage.
  load(): Promise<void>;

  // Save the current index to persistent storage.
  save(): Promise<void>;

  // Add or update an asset in the index.
  upsert(asset: IndexedAsset): void;

  // Check if an asset needs re-analysis (by sha256 hash).
  needsUpdate(path: string, sha256: string): boolean;

  // Semantic search — returns top-k matches by cosine similarity.
  search(query: string, embedding: number[], k?: number): Promise<AssetMatch[]>;

  // Get all indexed asset paths (for diffing against storage).
  indexedPaths(): string[];
}
