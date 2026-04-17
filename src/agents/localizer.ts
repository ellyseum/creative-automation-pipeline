/**
 * Localizer agent — cultural adaptation of the campaign message.
 *
 * NOT literal translation — cultural adaptation. "Level Up Your Morning"
 * doesn't translate directly to Japanese. The localizer considers:
 * - Local idioms and expressions
 * - Character count (important for ad overlays — CJK needs fewer chars)
 * - Cultural context (some metaphors don't travel)
 * - Reading direction implications
 *
 * For en-US region, this is a pass-through (no localization needed).
 * Results are cached per region within a run to avoid redundant LLM calls
 * when multiple products share the same message + region.
 */

import { z } from 'zod';
import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';

export interface LocalizerInput {
  message: string;        // source message (typically English)
  region: string;         // target region: "en-US", "ja-JP", "es-MX", etc.
  audience: string;       // target audience context
  brandTone?: string;     // brand tone for style matching
}

const LocalizerOutputSchema = z.object({
  localized: z.string().describe('The culturally-adapted message for the target region'),
  rationale: z.string().describe('Why this adaptation was chosen'),
  warnings: z.array(z.string()).optional().describe('Any caveats about the adaptation'),
});

export type LocalizerOutput = z.infer<typeof LocalizerOutputSchema>;

export class LocalizerAgent implements Agent<LocalizerInput, LocalizerOutput> {
  readonly name = 'localizer';

  // Cache localized messages per region within a run — same message + region = same result
  private cache = new Map<string, LocalizerOutput>();

  async execute(input: LocalizerInput, ctx: RunContext): Promise<LocalizerOutput> {
    // For English regions, pass through — no localization needed
    if (input.region.startsWith('en')) {
      return {
        localized: input.message,
        rationale: 'Source language matches target region — no adaptation needed.',
      };
    }

    // Check cache — avoid re-localizing the same message for the same region
    const cacheKey = `${input.region}:${input.message}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const system = [
      'You are a localization specialist for global advertising campaigns.',
      'Your task is CULTURAL ADAPTATION, not literal translation.',
      'Consider: local idioms, cultural context, character count for ad overlays,',
      'reading direction, and whether metaphors travel across cultures.',
      'Keep the adapted message concise — it will be rendered as a headline on social ads.',
    ].join('\n');

    const userMessage = [
      `Source message: "${input.message}"`,
      `Target region: ${input.region}`,
      `Target audience: ${input.audience}`,
      input.brandTone ? `Brand tone: ${input.brandTone}` : '',
    ].filter(Boolean).join('\n');

    const resp = await ctx.adapters.llm.complete({
      system,
      messages: [{ role: 'user', content: userMessage }],
      schema: LocalizerOutputSchema,
    });

    const result = LocalizerOutputSchema.parse(JSON.parse(resp.text!));
    this.cache.set(cacheKey, result);
    return result;
  }
}
