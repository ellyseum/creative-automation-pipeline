/**
 * Local filesystem storage adapter — the default for development and demos.
 *
 * Reads input assets from `./assets/` and writes outputs to `./output/run-<id>/`.
 * Same Storage interface as AzureBlobStorage — the pipeline doesn't know the difference.
 * This is the "no credentials, just works" path for reviewers cloning the repo.
 */

import { readFile, writeFile, stat, readdir, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Storage } from '../ports/storage.js';

export class LocalFsStorage implements Storage {
  readonly name = 'local-fs';
  private baseDir: string; // root directory for all reads/writes

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = baseDir;
  }

  // Resolve a key (relative path) to an absolute filesystem path.
  private resolve(key: string): string {
    return join(this.baseDir, key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.resolve(prefix);
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => {
          // Build relative path from prefix
          const parent = e.parentPath || e.path || '';
          const rel = parent.replace(dir, '').replace(/^[\\/]/, '');
          return join(prefix, rel, e.name);
        });
    } catch {
      return []; // directory doesn't exist — no assets
    }
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<{ key: string; url?: string }> {
    const fullPath = this.resolve(key);
    // Ensure parent directory exists (output paths may be deeply nested)
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);
    return { key };
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch {
      // Ignore — file may not exist
    }
  }
}
