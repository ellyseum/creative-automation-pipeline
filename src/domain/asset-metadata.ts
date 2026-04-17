/**
 * Asset metadata types — output of the Asset Analyzer agent.
 *
 * Each asset in the library gets analyzed by a multimodal LLM that produces
 * structured metadata: description, tags, mood, dominant colors, etc.
 * This metadata is then embedded as text (not raw pixels) for RAG retrieval.
 *
 * Why text embeddings of descriptions instead of raw image embeddings:
 * - Descriptions are inspectable — you can read WHY a match ranked where it did
 * - Text embeddings are cheaper and more stable
 * - The metadata feeds other agents (Brand Auditor, Composer) directly
 */

// Structured analysis of a single asset — produced by Asset Analyzer.
export interface AssetMetadata {
  description: string;            // natural-language description of the image
  tags: string[];                 // searchable keywords
  mood: string;                   // emotional tone: "aspirational", "calm", etc.
  subjects: string[];             // what's in the image: "water bottle", "person"
  setting: string;                // where: "indoor kitchen", "outdoor park"
  dominantColors: string[];       // hex colors detected in the image
  brandElements: {
    logoPresent: boolean;         // whether a logo is visible
    textPresent: boolean;         // whether text/copy is visible
  };
  usageHints: string[];           // how the asset could be used: "hero-ready", "lifestyle"
}

// An indexed asset — metadata + embedding + file reference.
// Stored in .embeddings/index.json, keyed by file content hash.
export interface IndexedAsset {
  path: string;                   // relative path in assets/
  sha256: string;                 // content hash for idempotent re-analysis
  analyzedAt: string;             // ISO 8601 timestamp
  metadata: AssetMetadata;
  embedding: number[];            // text embedding of the description (768 or 3072 dims)
}

// A search result from the AssetIndex — includes similarity score.
export interface AssetMatch {
  path: string;
  similarity: number;             // 0–1 cosine similarity
  metadata: AssetMetadata;
}

// The full embedding index — persisted to .embeddings/index.json.
export interface AssetIndexFile {
  version: number;                // schema version for forward compat
  generatedAt: string;            // ISO 8601
  embeddingModel: string;         // e.g., "gemini-embedding-001"
  embeddingDims: number;          // e.g., 768
  assets: IndexedAsset[];
}
