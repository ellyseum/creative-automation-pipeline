/**
 * E2E test — runs the full pipeline with stub adapters.
 *
 * Verifies the pipeline produces the expected output structure:
 * - 6 creative PNGs (2 products × 3 aspect ratios)
 * - manifest.json with cost summary and product results
 * - report.md (LLM-generated executive summary)
 * - audit.jsonl with per-agent invocation records
 *
 * Uses IMAGE_PROVIDER=stub so no real API calls are made.
 * This tests the pipeline LOGIC — composition, orchestration,
 * file organization, audit trail — without burning API credits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

describe('Pipeline E2E (stub mode)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'pipeline-e2e-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('produces 6 creatives, manifest, report, and audit log', async () => {
    // Run the pipeline in stub mode — no API keys needed
    const projectRoot = join(import.meta.dirname, '..');
    const briefPath = join(projectRoot, 'briefs', 'example.yaml');

    const runId = `test-e2e-${Date.now()}`;
    execSync(
      `npx tsx src/cli.ts run "${briefPath}" --run-id "${runId}" -o "${tmpDir}"`,
      {
        cwd: projectRoot,
        env: { ...process.env, IMAGE_PROVIDER: 'stub', LOG_LEVEL: 'warn' },
        timeout: 30000,
        stdio: 'pipe',
      },
    );

    const runDir = join(tmpDir, runId);

    // --- Verify manifest exists and has required fields ---
    const manifestRaw = await readFile(join(runDir, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw);

    expect(manifest.runId).toBe(runId);
    expect(manifest.briefFile).toContain('example.yaml');
    expect(manifest.products).toHaveLength(2);
    expect(manifest.costSummary).toBeDefined();
    expect(manifest.costSummary.totalUsdEst).toBeGreaterThanOrEqual(0);
    expect(manifest.stats.totalCreatives).toBe(6);
    expect(manifest.stats.totalProducts).toBe(2);

    // --- Verify report.md exists ---
    const reportStat = await stat(join(runDir, 'report.md'));
    expect(reportStat.size).toBeGreaterThan(10);

    // --- Verify audit.jsonl exists and has entries ---
    const auditRaw = await readFile(join(runDir, 'audit.jsonl'), 'utf-8');
    const auditLines = auditRaw.trim().split('\n').filter(Boolean);
    // At minimum: 1 director + 1 prompt-eng + 1 hero-gen + 1 brand-audit +
    //             2 localizers + 6 composers + 6 brand-audits + 6 legal + 1 report = ~24+
    expect(auditLines.length).toBeGreaterThan(10);

    // Each line is valid JSON with required fields
    for (const line of auditLines) {
      const inv = JSON.parse(line);
      expect(inv.invocationId).toBeDefined();
      expect(inv.runId).toBe(runId);
      expect(inv.agent).toBeDefined();
      expect(inv.status).toMatch(/^(ok|retry|error)$/);
    }

    // --- Verify creative output structure ---
    // output/<runId>/creatives/<product>/<ratio>.png
    const creativesDir = join(runDir, 'creatives');
    const products = await readdir(creativesDir);
    // Filter out _intermediate
    const productDirs = products.filter(p => !p.startsWith('_'));
    expect(productDirs.sort()).toEqual(['dawn-brew', 'solar-flask']);

    for (const product of productDirs) {
      const files = await readdir(join(creativesDir, product));
      const pngs = files.filter(f => f.endsWith('.png'));
      expect(pngs.sort()).toEqual(['16x9.png', '1x1.png', '9x16.png']);

      // Each PNG should be a real image (non-zero size)
      for (const png of pngs) {
        const s = await stat(join(creativesDir, product, png));
        expect(s.size).toBeGreaterThan(100);
      }
    }

    // --- Verify _audit directory has per-invocation artifacts ---
    const auditDir = join(runDir, '_audit');
    const auditDirs = await readdir(auditDir);
    expect(auditDirs.length).toBeGreaterThan(5);
  }, 60000);  // 60s timeout for the full stub pipeline
});
