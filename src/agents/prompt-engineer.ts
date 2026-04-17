/**
 * Prompt Engineer agent — crafts diffusion-optimized prompts from creative concepts.
 *
 * Takes the Creative Director's concept + product info + optional style reference
 * and produces a detailed prompt for Imagen/Firefly/DALL-E. The output includes:
 * - The main prompt (optimized for photorealistic product photography)
 * - A negative prompt (what to avoid — common noise that competes with text overlay)
 * - Reasoning (why these choices — for the audit trail)
 *
 * This is where prompt engineering skill shows: matching brand tone, audience
 * expectations, and the specific diffusion model's prompt conventions.
 */

import { z } from 'zod';
import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';

// Input: creative concept from the director + product info
export interface PromptEngineerInput {
  productId: string;
  productName: string;
  productDescription: string;
  generationDirection: string; // from CreativePlan.ProductPlan
  brandTone?: string;
  brandPalette: string[];
  audience: string;
  region: string;
  referenceDescription?: string; // from the style reference asset's metadata
  retryFeedback?: string; // from Brand Auditor on previous attempt (ReAct loop)
}

// Zod schema for structured prompt output
const PromptOutputSchema = z.object({
  prompt: z.string().describe('Detailed prompt optimized for photorealistic image generation'),
  negativePrompt: z.string().describe('What to avoid: common noise, off-brand elements'),
  reasoning: z.string().describe('Why these prompt choices — for audit trail'),
});

export type PromptOutput = z.infer<typeof PromptOutputSchema>;

export class PromptEngineerAgent implements Agent<PromptEngineerInput, PromptOutput> {
  readonly name = 'prompt-engineer';

  async execute(input: PromptEngineerInput, ctx: RunContext): Promise<PromptOutput> {
    // System prompt — gives the engineer its role and optimization targets
    const system = [
      'You are a prompt engineer specializing in product photography for social ad campaigns.',
      'Given a creative concept and product info, write a detailed prompt optimized for',
      'Imagen 4 (photorealistic image generation).',
      '',
      'Prompt engineering guidelines:',
      '- Lead with the subject, then describe environment, lighting, and mood',
      '- Include camera terms: "shallow depth of field", "studio lighting", "4k"',
      '- Reference the brand palette colors naturally (e.g., "warm copper tones")',
      '- Avoid text in the image — text overlay is added separately by the Composer',
      '- Keep prompts under 300 words — longer prompts lose focus',
      '',
      'The negative prompt should exclude:',
      '- Noise that competes with later text overlay (existing text, watermarks)',
      '- Off-brand aesthetics (if brand is minimal, exclude "cluttered", etc.)',
      '- Common generation artifacts (blurry, low quality, distorted)',
    ].join('\n');

    // Build the user message — all the context the engineer needs
    const userMessage = [
      `Product: ${input.productName} — ${input.productDescription}`,
      `Creative direction: ${input.generationDirection}`,
      `Brand tone: ${input.brandTone ?? 'not specified'}`,
      `Brand palette: ${input.brandPalette.join(', ')}`,
      `Audience: ${input.audience}`,
      `Region: ${input.region}`,
      input.referenceDescription
        ? `\nStyle reference asset (match this mood, do NOT copy the subject):\n${input.referenceDescription}`
        : '',
      input.retryFeedback
        ? `\n⚠ PREVIOUS ATTEMPT FAILED BRAND AUDIT. Feedback:\n${input.retryFeedback}\nAdjust the prompt to address this feedback.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const resp = await ctx.adapters.llm.complete({
      system,
      messages: [{ role: 'user', content: userMessage }],
      schema: PromptOutputSchema,
    });

    return PromptOutputSchema.parse(JSON.parse(resp.text!));
  }
}
