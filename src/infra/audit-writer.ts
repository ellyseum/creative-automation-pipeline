/**
 * Audit writer — append-only JSONL log + per-invocation artifact storage.
 *
 * Every agent invocation gets one line in audit.jsonl and its input/output
 * artifacts saved to _audit/<invocationId>/. This gives:
 * - Grep-friendly event log (one JSON per line, text tools work)
 * - Warehouse-ingestible format (JSONL → Snowflake/BigQuery trivially)
 * - Per-invocation replay (read input artifact, re-run agent, diff output)
 * - Immutable record (append-only, no updates after write)
 *
 * JSONL over SQLite because: no concurrent writers in a CLI tool, no lock
 * contention, and the format maps directly to event streams at scale.
 */

import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentInvocation } from '../domain/invocation.js';

export class AuditWriter {
  private outputDir: string;
  private auditFile: string;
  private initialized = false;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    this.auditFile = join(outputDir, 'audit.jsonl');
  }

  // Ensure the output directory exists — called lazily on first write.
  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.outputDir, { recursive: true });
    await mkdir(join(this.outputDir, '_audit'), { recursive: true });
    this.initialized = true;
  }

  // Append one invocation record to audit.jsonl.
  async append(invocation: AgentInvocation): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(invocation) + '\n';
    await appendFile(this.auditFile, line, 'utf-8');
  }

  // Write an artifact (input or output) for a specific invocation.
  // Returns the relative path (for referencing in the invocation record).
  async writeArtifact(invocationId: string, name: string, data: Buffer | string): Promise<string> {
    await this.ensureDir();
    const dir = join(this.outputDir, '_audit', invocationId);
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, name);
    const content = typeof data === 'string' ? data : data;
    await writeFile(filePath, content);

    // Return relative path from the output root — not absolute
    return join('_audit', invocationId, name);
  }
}
