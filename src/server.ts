/**
 * Web server — Express API for running the pipeline and viewing results.
 *
 * Features:
 * - Job queue: POST /api/run enqueues a pipeline run, returns job ID immediately
 * - Job polling: GET /api/jobs/:id returns status (queued/running/completed/failed)
 * - Run listing: GET /api/runs lists past completed runs
 * - Static serving: GET /output/* serves generated creatives
 * - Frontend: GET / serves the single-page UI
 *
 * The job queue is in-memory (not persistent) — appropriate for a PoC.
 * At production scale, swap for a real queue (Redis/SQS/Azure Queue).
 *
 * Start: npx tsx src/server.ts
 */

import express from 'express';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveAdapters } from './adapters/factory.js';
import { Logger } from './infra/logger.js';
import { AuditWriter } from './infra/audit-writer.js';
import { CostTracker } from './infra/cost-tracker.js';
import { RunContext } from './infra/run-context.js';
import { generateCreatives } from './use-cases/generate-creatives.js';
import { optional } from './infra/env.js';

const PORT = parseInt(optional('PORT', '3000') ?? '3000', 10);
const app = express();
app.use(express.json());

// --- In-memory job queue ---
// Each pipeline run is a "job" with a status lifecycle: queued → running → completed | failed

interface Job {
  id: string;
  briefPath: string;
  runId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
  error?: string;
  manifest?: unknown;
}

const jobs = new Map<string, Job>();

// --- API Routes ---

// POST /api/run — enqueue a pipeline run
// Returns immediately with a job ID; client polls /api/jobs/:id for status.
app.post('/api/run', (req, res) => {
  const briefPath = req.body.brief || 'briefs/example.yaml';
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const jobId = `job-${Date.now().toString(36)}`;

  const job: Job = {
    id: jobId,
    briefPath,
    runId,
    status: 'queued',
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  // Execute pipeline in background — don't await
  runPipeline(job).catch(() => {});

  res.status(202).json({ jobId, runId, status: 'queued' });
});

// GET /api/jobs/:id — poll job status
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET /api/jobs — list all jobs
app.get('/api/jobs', (_req, res) => {
  const all = [...jobs.values()].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  res.json({ jobs: all });
});

// GET /api/runs — list past run directories
app.get('/api/runs', async (_req, res) => {
  try {
    const dirs = await readdir('output');
    const runs = dirs.filter(d => d.startsWith('run-')).sort().reverse();
    res.json({ runs });
  } catch {
    res.json({ runs: [] });
  }
});

// GET /api/runs/:id — get manifest for a specific run
app.get('/api/runs/:id', async (req, res) => {
  try {
    const data = await readFile(join('output', req.params.id, 'manifest.json'), 'utf-8');
    res.json(JSON.parse(data));
  } catch {
    res.status(404).json({ error: 'Manifest not found' });
  }
});

// GET /api/briefs — list available brief files
app.get('/api/briefs', async (_req, res) => {
  const files = await readdir('briefs');
  res.json({ briefs: files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml')) });
});

// GET /api/runs/:id/creatives — list creative files for a run
app.get('/api/runs/:id/creatives', async (req, res) => {
  try {
    const creativesDir = join('output', req.params.id, 'creatives');
    const products = await readdir(creativesDir);
    const result: Record<string, string[]> = {};
    for (const product of products) {
      if (product.startsWith('_')) continue; // skip _intermediate
      const files = await readdir(join(creativesDir, product));
      result[product] = files.filter(f => f.endsWith('.png'));
    }
    res.json({ runId: req.params.id, creatives: result });
  } catch {
    res.status(404).json({ error: 'Creatives not found' });
  }
});

// GET /api/runs/:id/audit — get audit log entries
app.get('/api/runs/:id/audit', async (req, res) => {
  try {
    const data = await readFile(join('output', req.params.id, 'audit.jsonl'), 'utf-8');
    const entries = data.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    res.json({ runId: req.params.id, invocations: entries });
  } catch {
    res.status(404).json({ error: 'Audit log not found' });
  }
});

// GET /api/runs/:id/report — get the markdown report
app.get('/api/runs/:id/report', async (req, res) => {
  try {
    const data = await readFile(join('output', req.params.id, 'report.md'), 'utf-8');
    res.type('text/markdown').send(data);
  } catch {
    res.status(404).json({ error: 'Report not found' });
  }
});

// Static: serve output files (creatives, manifest, report)
app.use('/output', express.static('output'));

// Static: serve frontend
app.use(express.static('src/web'));

// --- Pipeline execution ---

async function runPipeline(job: Job): Promise<void> {
  job.status = 'running';
  const outputDir = join('output', job.runId);
  const logLevel = (optional('LOG_LEVEL', 'info') ?? 'info') as 'debug' | 'info' | 'warn' | 'error';

  try {
    const adapters = resolveAdapters();
    const ctx = new RunContext({
      runId: job.runId,
      outputDir,
      logger: new Logger(logLevel),
      audit: new AuditWriter(outputDir),
      costs: new CostTracker(),
      adapters,
    });

    const manifest = await generateCreatives(job.briefPath, ctx);
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.manifest = manifest;
  } catch (err: any) {
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = err.message;
    console.error(`[job ${job.id}] Failed:`, err.message);
  }
}

// --- Start ---

app.listen(PORT, () => {
  console.log(`\n  Creative Pipeline Server`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  API:`);
  console.log(`    POST /api/run          — start a pipeline run`);
  console.log(`    GET  /api/jobs/:id     — poll job status`);
  console.log(`    GET  /api/jobs         — list all jobs`);
  console.log(`    GET  /api/runs         — list completed runs`);
  console.log(`    GET  /api/runs/:id     — get run manifest`);
  console.log(`    GET  /api/briefs       — list available briefs\n`);
});
