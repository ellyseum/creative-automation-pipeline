/**
 * Asset Analyzer agent — describes each image in the brand's asset library.
 *
 * Why not just embed raw image pixels? Three reasons:
 * 1. Descriptions are INSPECTABLE — you can read why a match ranked where it did
 * 2. Text embeddings are cheaper and more stable than multimodal embeddings
 * 3. The metadata feeds other agents: Brand Auditor uses dominant_colors,
 *    Composer uses subject_location, Prompt Engineer uses mood
 *
 * Each asset is analyzed once and cached by sha256 content hash.
 * Re-analysis only happens when the file changes — idempotent by design.
 */

import { z } from 'zod';
import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';
import type { AssetMetadata } from '../domain/asset-metadata.js';

// Input: raw image bytes + path hint for context
export interface AssetAnalyzerInput {
  image: Buffer;
  mimeType: string;
  pathHint?: string; // e.g., "assets/products/solar-flask/hero.jpg"
  brandName?: string; // e.g., "Morning Co." — gives the LLM context
}

// Zod schema for structured output — forces the LLM to return this exact shape.
// Using zod means we get both type safety AND JSON Schema for the Gemini API.
const AssetMetadataSchema = z.object({
  description: z.string().describe('Natural-language description of the image content'),
  tags: z.array(z.string()).describe('Searchable keywords for this asset'),
  mood: z.string().describe('Emotional tone: aspirational, calm, energetic, etc.'),
  subjects: z.array(z.string()).describe('What is in the image: water bottle, person, etc.'),
  setting: z.string().describe('Where: indoor kitchen, outdoor park, studio, etc.'),
  dominantColors: z.array(z.string()).describe('Hex color codes of dominant colors'),
  brandElements: z.object({
    logoPresent: z.boolean().describe('Whether a brand logo is visible'),
    textPresent: z.boolean().describe('Whether text/copy is visible'),
  }),
  usageHints: z.array(z.string()).describe('How this asset could be used: hero-ready, lifestyle, reference-only'),
});

export class AssetAnalyzerAgent implements Agent<AssetAnalyzerInput, AssetMetadata> {
  readonly name = 'asset-analyzer';

  async execute(input: AssetAnalyzerInput, ctx: RunContext): Promise<AssetMetadata> {
    // System prompt gives the LLM its role and the output format.
    // The zod schema enforces structure; the prompt adds semantic guidance.
    const prompt = [
      `You are cataloging creative assets for${input.brandName ? ` brand "${input.brandName}"` : ' a brand library'}.`,
      `Analyze this image and return structured metadata.`,
      `Focus on creative-ops-useful attributes: mood, dominant colors (as hex codes),`,
      `composition style, subjects, setting, whether a logo or text overlay is visible,`,
      `and hints about how this asset could be used in campaigns.`,
      input.pathHint ? `\nFilename hint: ${input.pathHint}` : '',
    ].join('\n');

    const result = await ctx.adapters.multimodal.analyzeImage({
      image: input.image,
      mimeType: input.mimeType,
      prompt,
      schema: AssetMetadataSchema,
    });

    // Parse the structured response — zod validates and types it
    const parsed = JSON.parse(result.text);
    // DEBUG: log what was parsed to diagnose stub issues
    if (process.env.LOG_LEVEL === 'debug') {
      console.error('[asset-analyzer] parsed keys:', Object.keys(parsed));
    }
    return AssetMetadataSchema.parse(parsed);
  }
}
