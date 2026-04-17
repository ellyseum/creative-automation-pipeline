#!/usr/bin/env node

/**
 * Creative Automation Pipeline — CLI entry point.
 *
 * Subcommands:
 *   pipeline run <brief>     — run the full pipeline on a campaign brief
 *   pipeline audit <run-dir> — inspect a past run's agent invocations
 *   pipeline cost <run-dir>  — show cost breakdown for a past run
 *
 * The CLI is a driver (outermost ring in Clean Architecture) — it resolves
 * adapters, creates the RunContext, and delegates to use cases. No business
 * logic lives here.
 */

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveAdapters } from './adapters/factory.js';
import { Logger } from './infra/logger.js';
import { AuditWriter } from './infra/audit-writer.js';
import { CostTracker } from './infra/cost-tracker.js';
import { RunContext } from './infra/run-context.js';
import { generateCreatives } from './use-cases/generate-creatives.js';
import { optional } from './infra/env.js';

const program = new Command();

program
  .name('pipeline')
  .description('AI-powered creative automation pipeline for social ad campaigns')
  .version('1.0.0');

// --- run: execute the full pipeline ---
program
  .command('run')
  .description('Run the creative pipeline on a campaign brief')
  .argument('<brief>', 'Path to campaign brief (YAML)')
  .option('-o, --output <dir>', 'Output directory', 'output')
  .option('--run-id <id>', 'Custom run ID (default: auto-generated)')
  .action(async (briefPath: string, opts: { output: string; runId?: string }) => {
    try {
      const runId = opts.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
      const outputDir = join(opts.output, runId);
      const logLevel = (optional('LOG_LEVEL', 'info') ?? 'info') as 'debug' | 'info' | 'warn' | 'error';

      // Resolve all adapters from env vars — composition root
      const adapters = resolveAdapters();
      const logger = new Logger(logLevel);
      const audit = new AuditWriter(outputDir);
      const costs = new CostTracker();

      const ctx = new RunContext({ runId, outputDir, logger, audit, costs, adapters });

      // Run the full pipeline
      await generateCreatives(briefPath, ctx);

      // Print final manifest path
      logger.summary(`Manifest: ${join(outputDir, 'manifest.json')}`);
      process.exit(0);
    } catch (err) {
      console.error('\x1b[31mPipeline failed:\x1b[0m', (err as Error).message);
      if (optional('LOG_LEVEL') === 'debug') console.error(err);
      process.exit(1);
    }
  });

// --- audit: inspect a past run ---
program
  .command('audit')
  .description('Inspect agent invocations from a past run')
  .argument('<run-dir>', 'Path to run output directory')
  .action(async (runDir: string) => {
    try {
      const auditFile = join(runDir, 'audit.jsonl');
      const raw = await readFile(auditFile, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);

      console.log(`\n\x1b[1mAudit: ${runDir}\x1b[0m`);
      console.log(`${lines.length} agent invocations\n`);

      // Summary table: agent → count, total duration, total cost
      const summary: Record<string, { count: number; durationMs: number; costUsd: number }> = {};

      for (const line of lines) {
        const inv = JSON.parse(line);
        const key = inv.agent;
        if (!summary[key]) summary[key] = { count: 0, durationMs: 0, costUsd: 0 };
        summary[key].count++;
        summary[key].durationMs += inv.durationMs ?? 0;
        summary[key].costUsd += inv.costUsdEst ?? 0;
      }

      console.log('Agent                   | Calls | Duration | Cost');
      console.log('------------------------|-------|----------|-------');
      for (const [agent, s] of Object.entries(summary)) {
        const name = agent.padEnd(24);
        const calls = String(s.count).padStart(5);
        const dur = `${(s.durationMs / 1000).toFixed(1)}s`.padStart(8);
        const cost = `$${s.costUsd.toFixed(4)}`.padStart(7);
        console.log(`${name}| ${calls} | ${dur} | ${cost}`);
      }

      console.log('');
    } catch (err) {
      console.error('Failed to read audit log:', (err as Error).message);
      process.exit(1);
    }
  });

// --- cost: breakdown from manifest ---
program
  .command('cost')
  .description('Show cost breakdown for a past run')
  .argument('<run-dir>', 'Path to run output directory')
  .action(async (runDir: string) => {
    try {
      const raw = await readFile(join(runDir, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw);
      const costs = manifest.costSummary;

      console.log(`\n\x1b[1mCost Breakdown: ${runDir}\x1b[0m`);
      console.log(`Total: \x1b[32m$${costs.totalUsdEst.toFixed(4)}\x1b[0m\n`);

      console.log('By Agent:');
      for (const [agent, cost] of Object.entries(costs.byAgent as Record<string, number>)) {
        console.log(`  ${agent.padEnd(25)} $${cost.toFixed(4)}`);
      }

      console.log('\nBy Product:');
      for (const [product, cost] of Object.entries(costs.byProduct as Record<string, number>)) {
        console.log(`  ${product.padEnd(25)} $${cost.toFixed(4)}`);
      }

      console.log('\nBy Provider:');
      for (const [provider, cost] of Object.entries(costs.byProvider as Record<string, number>)) {
        console.log(`  ${provider.padEnd(25)} $${cost.toFixed(4)}`);
      }

      console.log('');
    } catch (err) {
      console.error('Failed to read manifest:', (err as Error).message);
      process.exit(1);
    }
  });

program.parse();
