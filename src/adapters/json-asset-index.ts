/**
 * JSON-file-backed asset index — in-memory cosine similarity for RAG retrieval.
 *
 * For the demo: assets are indexed to .embeddings/index.json.
 * Search is brute-force cosine similarity over all vectors — at 100 assets
 * and 768 dimensions, this completes in under 0.1ms. No indexing needed.
 *
 * For production: swap in Azure AI Search, pgvector, or Pinecone via the
 * same AssetIndex interface. The search() call signature is identical.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { AssetIndex } from '../ports/asset-index.js';
import type { IndexedAsset, AssetMatch, AssetIndexFile } from '../domain/asset-metadata.js';

// Cosine similarity between two vectors — the core of in-memory RAG.
// 8 lines, sub-millisecond for any demo-scale dataset.
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export class JsonAssetIndex implements AssetIndex {
  readonly name = 'json-asset-index';
  private indexPath: string;
  private assets: Map<string, IndexedAsset> = new Map();  // keyed by path
  private embeddingModel = '';
  private embeddingDims = 0;

  constructor(indexDir: string = '.embeddings') {
    this.indexPath = join(indexDir, 'index.json');
  }

  // Load existing index from disk — called once at pipeline start.
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.indexPath, 'utf-8');
      const data: AssetIndexFile = JSON.parse(raw);
      this.embeddingModel = data.embeddingModel;
      this.embeddingDims = data.embeddingDims;
      for (const asset of data.assets) {
        this.assets.set(asset.path, asset);
      }
    } catch {
      // No existing index — start fresh (first run)
    }
  }

  // Persist the current index to disk — called after analyzing new/changed assets.
  async save(): Promise<void> {
    const data: AssetIndexFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      embeddingModel: this.embeddingModel,
      embeddingDims: this.embeddingDims,
      assets: [...this.assets.values()],
    };
    await mkdir(dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // Add or update an asset in the index.
  upsert(asset: IndexedAsset): void {
    this.assets.set(asset.path, asset);
    // Track embedding dimensions from first upsert
    if (!this.embeddingDims && asset.embedding.length) {
      this.embeddingDims = asset.embedding.length;
    }
    if (!this.embeddingModel) {
      this.embeddingModel = 'gemini-embedding-001';  // default for this pipeline
    }
  }

  // Check if an asset needs re-analysis — by comparing content hash.
  needsUpdate(path: string, sha256: string): boolean {
    const existing = this.assets.get(path);
    // Asset needs update if: not indexed at all, or content hash changed
    return !existing || existing.sha256 !== sha256;
  }

  // Semantic search — brute-force cosine similarity over all indexed assets.
  // Returns top-k matches sorted by similarity (highest first).
  async search(_query: string, embedding: number[], k: number = 5): Promise<AssetMatch[]> {
    const matches: AssetMatch[] = [];

    for (const asset of this.assets.values()) {
      // Skip assets without embeddings (shouldn't happen, but defensive)
      if (!asset.embedding?.length) continue;

      const similarity = cosineSimilarity(embedding, asset.embedding);
      matches.push({
        path: asset.path,
        similarity,
        metadata: asset.metadata,
      });
    }

    // Sort by similarity descending, return top-k
    return matches
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  // Get all indexed asset paths — for diffing against storage to find new/removed assets.
  indexedPaths(): string[] {
    return [...this.assets.keys()];
  }
}
