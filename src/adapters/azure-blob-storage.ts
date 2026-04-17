/**
 * Azure Blob Storage adapter — works with both real Azure and Azurite (local mock).
 *
 * Same SDK (@azure/storage-blob), same code, same connection string pattern.
 * The only difference between local dev and production is the connection string:
 * - Azurite: http://127.0.0.1:10000/devstoreaccount1 (well-known dev credentials)
 * - Azure: https://<account>.blob.core.windows.net (real SAS token or connection string)
 *
 * Docker-compose ships Azurite so the demo runs fully offline.
 * In a real client engagement, this adapter connects to their Azure Blob without code changes.
 */

import { BlobServiceClient } from '@azure/storage-blob';
import type { Storage } from '../ports/storage.js';

// Default container name for pipeline assets
const DEFAULT_CONTAINER = 'pipeline-assets';

export class AzureBlobStorage implements Storage {
  readonly name = 'azure-blob';
  private client: BlobServiceClient;
  private containerName: string;
  private initialized = false;

  constructor(opts: { connectionString: string; container?: string }) {
    this.client = BlobServiceClient.fromConnectionString(opts.connectionString);
    this.containerName = opts.container ?? DEFAULT_CONTAINER;
  }

  // Ensure the container exists — lazily on first operation.
  private async ensureContainer(): Promise<void> {
    if (this.initialized) return;
    const container = this.client.getContainerClient(this.containerName);
    // createIfNotExists is idempotent — safe to call every time
    await container.createIfNotExists({ access: 'blob' });
    this.initialized = true;
  }

  private container() {
    return this.client.getContainerClient(this.containerName);
  }

  async exists(key: string): Promise<boolean> {
    await this.ensureContainer();
    try {
      await this.container().getBlockBlobClient(key).getProperties();
      return true;
    } catch {
      return false; // 404 → doesn't exist
    }
  }

  async get(key: string): Promise<Buffer> {
    await this.ensureContainer();
    const resp = await this.container().getBlockBlobClient(key).downloadToBuffer();
    return resp;
  }

  async list(prefix: string): Promise<string[]> {
    await this.ensureContainer();
    const paths: string[] = [];
    // List all blobs matching the prefix — Azure Blob uses flat namespace with / separators
    for await (const blob of this.container().listBlobsFlat({ prefix })) {
      paths.push(blob.name);
    }
    return paths;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<{ key: string; url: string }> {
    await this.ensureContainer();
    const blob = this.container().getBlockBlobClient(key);
    await blob.uploadData(data, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
    return { key, url: blob.url };
  }

  async delete(key: string): Promise<void> {
    await this.ensureContainer();
    try {
      await this.container().getBlockBlobClient(key).delete();
    } catch {
      // Ignore — blob may not exist
    }
  }
}
