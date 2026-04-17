/**
 * Legal Reviewer agent — hybrid compliance checker (regex + LLM).
 *
 * Two layers, same pattern as Brand Auditor:
 * 1. DETERMINISTIC: regex scan against a configurable prohibited-word list.
 *    Fast, free, catches obvious violations (health claims, guarantees).
 * 2. SEMANTIC: multimodal LLM analyzes the rendered creative for nuanced
 *    issues (implied claims in imagery, region-specific regulation concerns).
 *
 * The deterministic layer runs first. If it flags hard-blocked words, we
 * skip the LLM call (saves money on obvious failures). Otherwise, the LLM
 * provides nuanced analysis that captures implied claims a regex can't see.
 */

import { z } from 'zod';
import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';
import type { LegalCheckResult } from '../domain/creative.js';

export interface LegalReviewerInput {
  image: Buffer;           // the final rendered creative
  mimeType: string;
  message: string;         // the rendered text (for regex checks)
  region: string;          // region for regulatory context
  productCategory?: string;
}

// Default prohibited words for en-US advertising.
// In production, this would be configurable per region + product category.
const PROHIBITED_WORDS = [
  'cure', 'cures', 'miracle', 'guaranteed', 'guarantee',
  'risk-free', 'no risk', 'clinically proven',
  'FDA approved', 'doctor recommended',
  '#1', 'number one', 'best in class',
];

// Zod schema for the semantic LLM check
const SemanticLegalCheckSchema = z.object({
  flags: z.array(z.object({
    type: z.enum(['health_claim', 'implied_guarantee', 'comparative', 'prohibited_word']),
    text: z.string().describe('The specific text or visual element flagged'),
    severity: z.enum(['low', 'medium', 'high']),
  })),
  verdict: z.enum(['clear', 'review_needed', 'blocked']),
});

export class LegalReviewerAgent implements Agent<LegalReviewerInput, LegalCheckResult> {
  readonly name = 'legal-reviewer';

  async execute(input: LegalReviewerInput, ctx: RunContext): Promise<LegalCheckResult> {
    const flags: LegalCheckResult['flags'] = [];

    // --- Layer 1: Deterministic regex scan ---
    const lowerMessage = input.message.toLowerCase();
    for (const word of PROHIBITED_WORDS) {
      if (lowerMessage.includes(word.toLowerCase())) {
        flags.push({
          type: 'prohibited_word',
          text: word,
          severity: 'high',
        });
      }
    }

    // If hard-blocked words found, skip the LLM call — verdict is clear
    if (flags.some(f => f.severity === 'high')) {
      return { verdict: 'blocked', flags };
    }

    // --- Layer 2: Semantic LLM check on the rendered creative ---
    const prompt = [
      `You are a legal content reviewer for ${input.region} social media advertising.`,
      `Relevant regulations:`,
      input.region.startsWith('en-US') ? `- FTC advertising guidelines (truth in advertising, substantiation)` : '',
      input.region.startsWith('en-GB') ? `- ASA Code of Non-broadcast Advertising` : '',
      `- General: no unsubstantiated health claims, no implied guarantees, no misleading imagery`,
      '',
      `Campaign text: "${input.message}"`,
      input.productCategory ? `Product category: ${input.productCategory}` : '',
      '',
      `Analyze both the TEXT and IMAGERY in this ad creative.`,
      `Flag any regulatory concerns. Be conservative — flag "review_needed" for ambiguous cases.`,
    ].filter(Boolean).join('\n');

    const result = await ctx.adapters.multimodal.analyzeImage({
      image: input.image,
      mimeType: input.mimeType,
      prompt,
      schema: SemanticLegalCheckSchema,
    });

    const semantic = SemanticLegalCheckSchema.parse(JSON.parse(result.text));

    // Merge regex flags + LLM flags
    const allFlags = [...flags, ...semantic.flags];

    // Determine final verdict — regex "blocked" overrides LLM
    const verdict = allFlags.some(f => f.severity === 'high') ? 'blocked'
      : allFlags.length > 0 ? 'review_needed'
      : 'clear';

    return { verdict, flags: allFlags };
  }
}
