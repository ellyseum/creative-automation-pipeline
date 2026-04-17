/**
 * API E2E tests — starts the Express server, exercises all endpoints.
 *
 * Uses stub mode so no real API keys or GenAI calls are needed.
 * Verifies: job lifecycle, creative output, audit trail, briefs listing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dirname, '..');
// Random port in high range to avoid conflicts with other tests
const PORT = 30000 + Math.floor(Math.random() * 10000);
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;

// Helper: fetch with timeout
async function api(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...opts, signal: AbortSignal.timeout(10000) });
}

describe('API E2E', () => {
  beforeAll(async () => {
    // Start server in background with stub mode
    server = spawn('npx', ['tsx', 'src/server.ts'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, IMAGE_PROVIDER: 'stub', PORT: String(PORT), LOG_LEVEL: 'warn' },
      stdio: 'pipe',
    });
    // Surface server stderr so CI logs show the real failure when a job
    // crashes inside the server. Without this the child's errors vanish.
    server.stderr?.on('data', (b) => process.stderr.write(`[server] ${b}`));
    server.stdout?.on('data', (b) => process.stdout.write(`[server] ${b}`));

    // Wait for server to be ready
    for (let i = 0; i < 20; i++) {
      try {
        await fetch(`${BASE}/api/briefs`, { signal: AbortSignal.timeout(500) });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, 30000);

  afterAll(() => {
    server?.kill('SIGTERM');
  });

  it('GET /api/briefs returns available briefs', async () => {
    const resp = await api('/api/briefs');
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.briefs).toContain('example.yaml');
    expect(body.briefs).toContain('example-ja.yaml');
  });

  it('POST /api/run starts a job and returns 202', async () => {
    const resp = await api('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: 'briefs/example.yaml' }),
    });
    expect(resp.status).toBe(202);
    const body = await resp.json();
    expect(body.jobId).toBeDefined();
    expect(body.runId).toBeDefined();
    expect(body.status).toBe('queued');
  });

  it('full job lifecycle: queued → running → completed', async () => {
    // Start a run
    const startResp = await api('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: 'briefs/example.yaml' }),
    });
    const { jobId, runId } = await startResp.json();

    // Poll until completed (max 30s)
    let job: any;
    for (let i = 0; i < 30; i++) {
      const resp = await api(`/api/jobs/${jobId}`);
      job = await resp.json();
      if (job.status === 'completed' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (job.status !== 'completed') {
      // Dump the actual error so CI logs tell us what went wrong instead of
      // a bare "expected 'failed' to be 'completed'" mismatch.
      console.error('Job did not complete. Full job object:', JSON.stringify(job, null, 2));
    }
    expect(job.status).toBe('completed');
    expect(job.manifest).toBeDefined();
    expect(job.manifest.stats.totalCreatives).toBe(6);
    expect(job.manifest.stats.totalProducts).toBe(2);

    // Verify run appears in runs list
    const runsResp = await api('/api/runs');
    const { runs } = await runsResp.json();
    expect(runs).toContain(runId);

    // Verify manifest endpoint
    const manifestResp = await api(`/api/runs/${runId}`);
    expect(manifestResp.status).toBe(200);
    const manifest = await manifestResp.json();
    expect(manifest.runId).toBe(runId);

    // Verify creatives endpoint
    const creativesResp = await api(`/api/runs/${runId}/creatives`);
    expect(creativesResp.status).toBe(200);
    const { creatives } = await creativesResp.json();
    expect(Object.keys(creatives).sort()).toEqual(['dawn-brew', 'solar-flask']);
    expect(creatives['solar-flask']).toContain('1x1.png');

    // Verify audit endpoint
    const auditResp = await api(`/api/runs/${runId}/audit`);
    expect(auditResp.status).toBe(200);
    const { invocations } = await auditResp.json();
    expect(invocations.length).toBeGreaterThan(10);

    // Verify static file serving for creatives
    const imgResp = await api(`/output/${runId}/creatives/solar-flask/1x1.png`);
    expect(imgResp.status).toBe(200);
    expect(imgResp.headers.get('content-type')).toContain('image/png');
  }, 60000);

  it('GET /api/jobs lists all jobs', async () => {
    const resp = await api('/api/jobs');
    expect(resp.status).toBe(200);
    const { jobs } = await resp.json();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].status).toMatch(/queued|running|completed|failed/);
  });

  it('GET /api/jobs/:invalid returns 404', async () => {
    const resp = await api('/api/jobs/nonexistent');
    expect(resp.status).toBe(404);
  });

  it('GET / serves the frontend', async () => {
    const resp = await api('/');
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('Creative Pipeline');
    expect(html).toContain('Run Pipeline');
  });
});
