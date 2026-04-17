/**
 * JSON asset index tests — cosine similarity math and search ranking.
 */

import { describe, it, expect } from 'vitest';
import { JsonAssetIndex } from './json-asset-index.js';
import type { IndexedAsset } from '../domain/asset-metadata.js';

// Helper: create a unit vector in a given direction
function unitVec(dims: number, hotIndex: number): number[] {
  const v = new Array(dims).fill(0);
  v[hotIndex] = 1;
  return v;
}

function makeAsset(path: string, embedding: number[]): IndexedAsset {
  return {
    path,
    sha256: path, // use path as fake hash for testing
    analyzedAt: new Date().toISOString(),
    metadata: {
      description: `Asset at ${path}`,
      tags: [],
      mood: 'neutral',
      subjects: [],
      setting: 'unknown',
      dominantColors: [],
      brandElements: { logoPresent: false, textPresent: false },
      usageHints: [],
    },
    embedding,
  };
}

describe('JsonAssetIndex', () => {
  it('returns empty results for empty index', async () => {
    const idx = new JsonAssetIndex('/tmp/test-embeddings');
    const results = await idx.search('test', [1, 0, 0], 5);
    expect(results).toEqual([]);
  });

  it('ranks by cosine similarity', async () => {
    const idx = new JsonAssetIndex('/tmp/test-embeddings');
    // Three assets pointing in different directions
    idx.upsert(makeAsset('exact-match', unitVec(3, 0))); // [1,0,0]
    idx.upsert(makeAsset('partial-match', [0.7, 0.7, 0])); // 45 degrees off
    idx.upsert(makeAsset('orthogonal', unitVec(3, 2))); // [0,0,1] — 90 degrees off

    const results = await idx.search('test', unitVec(3, 0), 3); // query = [1,0,0]

    expect(results[0].path).toBe('exact-match');
    expect(results[0].similarity).toBeCloseTo(1.0);
    expect(results[1].path).toBe('partial-match');
    expect(results[1].similarity).toBeGreaterThan(0.5);
    expect(results[2].path).toBe('orthogonal');
    expect(results[2].similarity).toBeCloseTo(0);
  });

  it('respects top-k limit', async () => {
    const idx = new JsonAssetIndex('/tmp/test-embeddings');
    for (let i = 0; i < 10; i++) {
      idx.upsert(makeAsset(`asset-${i}`, unitVec(5, i % 5)));
    }
    const results = await idx.search('test', unitVec(5, 0), 3);
    expect(results).toHaveLength(3);
  });

  it('detects when assets need update', () => {
    const idx = new JsonAssetIndex('/tmp/test-embeddings');
    idx.upsert(makeAsset('file.jpg', [1, 0]));

    // Same hash — no update needed
    expect(idx.needsUpdate('file.jpg', 'file.jpg')).toBe(false);
    // Different hash — needs update
    expect(idx.needsUpdate('file.jpg', 'changed-hash')).toBe(true);
    // New file — needs update
    expect(idx.needsUpdate('new.jpg', 'any-hash')).toBe(true);
  });

  it('tracks indexed paths', () => {
    const idx = new JsonAssetIndex('/tmp/test-embeddings');
    idx.upsert(makeAsset('a.jpg', [1]));
    idx.upsert(makeAsset('b.jpg', [1]));
    expect(idx.indexedPaths()).toEqual(['a.jpg', 'b.jpg']);
  });
});
