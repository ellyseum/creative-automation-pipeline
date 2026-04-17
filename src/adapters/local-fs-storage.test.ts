/**
 * Integration tests for LocalFsStorage — verifies actual filesystem I/O.
 * Uses a temp directory so tests don't pollute the project.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFsStorage } from './local-fs-storage.js';

describe('LocalFsStorage', () => {
  let tmpDir: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'pipeline-test-'));
    storage = new LocalFsStorage(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('put + get round-trips a buffer', async () => {
    const data = Buffer.from('hello world');
    await storage.put('test/file.txt', data, 'text/plain');

    const result = await storage.get('test/file.txt');
    expect(result.toString()).toBe('hello world');
  });

  it('put creates nested directories', async () => {
    await storage.put('deep/nested/path/file.png', Buffer.from('img'), 'image/png');
    const result = await storage.get('deep/nested/path/file.png');
    expect(result.toString()).toBe('img');
  });

  it('exists returns true for existing files', async () => {
    await storage.put('exists.txt', Buffer.from('yes'), 'text/plain');
    expect(await storage.exists('exists.txt')).toBe(true);
  });

  it('exists returns false for missing files', async () => {
    expect(await storage.exists('nope.txt')).toBe(false);
  });

  it('list returns files under a prefix', async () => {
    await storage.put('assets/a.jpg', Buffer.from('a'), 'image/jpeg');
    await storage.put('assets/b.jpg', Buffer.from('b'), 'image/jpeg');
    await storage.put('other/c.jpg', Buffer.from('c'), 'image/jpeg');

    const listed = await storage.list('assets');
    expect(listed).toHaveLength(2);
    expect(listed.some((p) => p.includes('a.jpg'))).toBe(true);
    expect(listed.some((p) => p.includes('b.jpg'))).toBe(true);
  });

  it('list returns empty for missing prefix', async () => {
    const listed = await storage.list('nonexistent');
    expect(listed).toEqual([]);
  });

  it('delete removes a file', async () => {
    await storage.put('deleteme.txt', Buffer.from('gone'), 'text/plain');
    expect(await storage.exists('deleteme.txt')).toBe(true);
    await storage.delete!('deleteme.txt');
    expect(await storage.exists('deleteme.txt')).toBe(false);
  });

  it('delete does not throw for missing files', async () => {
    await expect(storage.delete!('nope.txt')).resolves.toBeUndefined();
  });
});
