/**
 * Report Writer agent — generates an executive summary from the run manifest.
 *
 * This is the stakeholder-facing output: a markdown report that a marketing
 * director can skim in 30 seconds and understand what happened. Written by
 * an LLM because the summary needs to be contextual, not template-driven —
 * it should highlight interesting decisions (why a product used hybrid vs.
 * generate), flag any compliance warnings, and suggest next actions.
 *
 * For the interview: this is the "the AI system explains itself" moment.
 * Every run produces a human-readable narrative alongside the machine-readable
 * manifest. At production scale, this becomes the campaign launch sign-off doc.
 */

import { z } from 'zod';
import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';
import type { RunManifest } from '../domain/manifest.js';

export interface ReportWriterInput {
  manifest: RunManifest;
}

const ReportOutputSchema = z.object({
  markdown: z.string().describe('Full markdown report, max 500 words, professional and skim-friendly'),
});

export type ReportOutput = z.infer<typeof ReportOutputSchema>;

export class ReportWriterAgent implements Agent<ReportWriterInput, ReportOutput> {
  readonly name = 'report-writer';

  async execute(input: ReportWriterInput, ctx: RunContext): Promise<ReportOutput> {
    const { manifest } = input;

    const system = [
      'You are an executive assistant summarizing a creative automation pipeline run',
      'for marketing stakeholders. Write a concise markdown report (max 500 words).',
      '',
      'Structure:',
      '1. Campaign headline (H1)',
      '2. Summary metrics (products, creatives, cost, duration)',
      '3. Per-product notes (strategy used, any compliance flags)',
      '4. Cost breakdown table',
      '5. Recommendations for next run (brief, actionable)',
      '',
      'Tone: professional, actionable, skim-friendly with bullet points.',
      'Use checkmarks (✓) for passes, warnings (⚠) for flagged items.',
    ].join('\n');

    // Serialize the manifest as context for the LLM — it has everything
    const userMessage = `Here is the full run manifest:\n\n${JSON.stringify(manifest, null, 2)}`;

    const resp = await ctx.adapters.llm.complete({
      system,
      messages: [{ role: 'user', content: userMessage }],
      schema: ReportOutputSchema,
    });

    return ReportOutputSchema.parse(JSON.parse(resp.text!));
  }
}
