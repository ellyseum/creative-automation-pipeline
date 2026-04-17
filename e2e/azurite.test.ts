/**
 * Azurite integration test — verifies the AzureBlobStorage adapter works
 * with a real Azurite instance via docker-compose.
 *
 * Requires: docker-compose up -d (Azurite on localhost:10000)
 * Skip condition: if Azurite isn't running, tests are skipped gracefully.
 *
 * Tests:
 * - Create container, put/get/exists/list/delete operations
 * - Round-trip binary data (PNG bytes)
 * - Container creation is idempotent
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AzureBlobStorage } from '../src/adapters/azure-blob-storage.js';

const AZURITE_CONN =
  'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';
const TEST_CONTAINER = `test-${Date.now()}`;

let storage: AzureBlobStorage;
// Check Azurite availability synchronously at module load
let azuriteAvailable = false;
try {
  const resp = await fetch('http://127.0.0.1:10000/', { signal: AbortSignal.timeout(2000) });
  azuriteAvailable = true;
} catch {
  console.log('⚠ Azurite not running — skipping blob storage tests. Run: docker-compose up -d');
}

beforeAll(async () => {
  if (azuriteAvailable) {
    storage = new AzureBlobStorage({ connectionString: AZURITE_CONN, container: TEST_CONTAINER });
  }
});

// Clean up test container
afterAll(async () => {
  if (!azuriteAvailable) return;
  try {
    // Delete all blobs in the test container
    const keys = await storage.list('');
    for (const key of keys) {
      await storage.delete!(key);
    }
  } catch {
    /* container may not exist */
  }
});

describe('AzureBlobStorage (Azurite)', () => {
  it.skipIf(!azuriteAvailable)('put + get round-trips text data', async () => {
    const data = Buffer.from('hello azurite');
    await storage.put('test/hello.txt', data, 'text/plain');
    const result = await storage.get('test/hello.txt');
    expect(result.toString()).toBe('hello azurite');
  });

  it.skipIf(!azuriteAvailable)('put + get round-trips binary data (PNG)', async () => {
    // Minimal PNG header bytes
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await storage.put('images/test.png', png, 'image/png');
    const result = await storage.get('images/test.png');
    expect(result[0]).toBe(0x89);
    expect(result[1]).toBe(0x50); // 'P'
    expect(result.length).toBe(8);
  });

  it.skipIf(!azuriteAvailable)('exists returns true for existing blobs', async () => {
    await storage.put('exists-test.txt', Buffer.from('yes'), 'text/plain');
    expect(await storage.exists('exists-test.txt')).toBe(true);
  });

  it.skipIf(!azuriteAvailable)('exists returns false for missing blobs', async () => {
    expect(await storage.exists('does-not-exist.txt')).toBe(false);
  });

  it.skipIf(!azuriteAvailable)('list returns blobs under a prefix', async () => {
    await storage.put('list-test/a.txt', Buffer.from('a'), 'text/plain');
    await storage.put('list-test/b.txt', Buffer.from('b'), 'text/plain');
    await storage.put('other/c.txt', Buffer.from('c'), 'text/plain');

    const listed = await storage.list('list-test/');
    expect(listed).toHaveLength(2);
    expect(listed.some((p) => p.includes('a.txt'))).toBe(true);
    expect(listed.some((p) => p.includes('b.txt'))).toBe(true);
  });

  it.skipIf(!azuriteAvailable)('delete removes a blob', async () => {
    await storage.put('delete-me.txt', Buffer.from('gone'), 'text/plain');
    expect(await storage.exists('delete-me.txt')).toBe(true);
    await storage.delete!('delete-me.txt');
    expect(await storage.exists('delete-me.txt')).toBe(false);
  });

  it.skipIf(!azuriteAvailable)('put returns blob URL', async () => {
    const result = await storage.put('url-test.txt', Buffer.from('url'), 'text/plain');
    expect(result.key).toBe('url-test.txt');
    expect(result.url).toContain('url-test.txt');
    expect(result.url).toContain('10000'); // Azurite port
  });
});
