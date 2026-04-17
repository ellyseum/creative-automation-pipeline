/**
 * Storage port — bidirectional file storage abstraction.
 *
 * Reads input assets (brand logos, product heroes) and writes generated
 * outputs (composited creatives, intermediates, audit artifacts).
 * Same interface for local filesystem and cloud storage (Azure Blob / S3).
 *
 * In a real client engagement, the client uploads assets to their cloud
 * storage, and the pipeline reads from the same place it writes to.
 * Azurite (local Azure mock) proves this works with zero real cloud deps.
 */

export interface Storage {
  readonly name: string;

  // --- Read operations (for input assets) ---
  exists(key: string): Promise<boolean>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<string[]>;

  // --- Write operations (for generated outputs + audit artifacts) ---
  put(key: string, data: Buffer, contentType: string): Promise<{ key: string; url?: string }>;

  // --- Housekeeping (optional — for transient intermediates) ---
  delete?(key: string): Promise<void>;
}
