/**
 * Integration tests for AuditWriter — verifies JSONL append and artifact storage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditWriter } from './audit-writer.js';
import type { AgentInvocation } from '../domain/invocation.js';

function makeInvocation(overrides?: Partial<AgentInvocation>): AgentInvocation {
  return {
    invocationId: 'inv-001',
    runId: 'run-test',
    agent: 'test-agent',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    status: 'ok',
    inputRef: '_audit/inv-001/input.json',
    ...overrides,
  };
}

describe('AuditWriter', () => {
  let tmpDir: string;
  let writer: AuditWriter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'audit-test-'));
    writer = new AuditWriter(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('appends invocations as JSONL', async () => {
    await writer.append(makeInvocation({ invocationId: 'a' }));
    await writer.append(makeInvocation({ invocationId: 'b' }));

    const content = await readFile(join(tmpDir, 'audit.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).invocationId).toBe('a');
    expect(JSON.parse(lines[1]).invocationId).toBe('b');
  });

  it('writes artifacts to _audit/<id>/', async () => {
    const ref = await writer.writeArtifact('inv-001', 'input.json', '{"test": true}');
    expect(ref).toBe(join('_audit', 'inv-001', 'input.json'));

    const content = await readFile(join(tmpDir, '_audit', 'inv-001', 'input.json'), 'utf-8');
    expect(content).toBe('{"test": true}');
  });

  it('handles Buffer artifacts', async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    const ref = await writer.writeArtifact('inv-002', 'output.png', buf);

    const read = await readFile(join(tmpDir, ref), null);
    expect(read[0]).toBe(0x89);
    expect(read.length).toBe(4);
  });
});
