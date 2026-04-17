/**
 * Brand Auditor agent — hybrid compliance checker (deterministic + LLM).
 *
 * Two layers of checking:
 * 1. DETERMINISTIC: color histogram analysis — are brand palette colors
 *    ≥30% of the image? Cheap, fast, no API call.
 * 2. SEMANTIC: multimodal LLM looks at the image and evaluates tone,
 *    composition, and overall brand alignment. More nuanced but costs money.
 *
 * The deterministic layer runs first (gate). If it passes, the semantic
 * layer confirms. If the deterministic layer fails, we skip the LLM
 * call and report the specific color issue (saves money on obvious failures).
 *
 * Output includes structured feedback that the orchestrator can feed back
 * to the Prompt Engineer for a retry (ReAct loop).
 */

import { z } from 'zod';
import sharp from 'sharp';
import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';
import type { BrandCheckResult } from '../domain/creative.js';

// Input: the image to audit + brand rules to check against
export interface BrandAuditorInput {
  image: Buffer;
  mimeType: string;
  brandPalette: string[];
  brandTone?: string;
  paletteDominanceThreshold?: number; // default: 0.3 (30%)
  isHeroCheck?: boolean; // true = checking raw hero, false = checking final creative
  // When true, a declared product reference is being preserved (e.g., kraft
  // tea packaging, copper bottle) and the product may have intrinsic colors
  // that aren't in the brand palette. The auditor must evaluate palette
  // compliance on SCENE elements only — not the product itself. Without
  // this, the auditor and subject-preservation agent issue contradictory
  // orders and the ReAct loop oscillates indefinitely.
  preserveSubject?: boolean;
  // Short description of the subject to exclude from palette judgment when
  // preserveSubject is true. Typically "${productName} — ${productDescription}".
  subjectDescription?: string;
}

// Zod schema for the semantic LLM check
const SemanticBrandCheckSchema = z.object({
  onBrand: z.boolean(),
  paletteUsage: z.enum(['strong', 'adequate', 'weak', 'off-brand']),
  toneMatch: z.enum(['strong', 'adequate', 'off']),
  issues: z.array(z.string()),
  suggestionsForRegeneration: z.array(z.string()),
  severity: z.enum(['none', 'minor', 'major']),
});

// --- Deterministic color analysis ---

// Convert hex color to RGB
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Color distance (Euclidean in RGB space — not perceptually uniform, but fast)
function colorDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

// Analyze what percentage of pixels are close to any brand palette color.
// Samples every 4th pixel for speed (4x downsampled resolution is plenty for color stats).
async function analyzePaletteDominance(image: Buffer, palette: string[]): Promise<number> {
  // Downscale for faster analysis — 100x100 is 10k pixels, plenty for color stats
  const { data, info } = await sharp(image)
    .resize(100, 100, { fit: 'cover' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const brandColors = palette.map(hexToRgb);
  const totalPixels = info.width * info.height;
  const channels = info.channels; // 3 (RGB) or 4 (RGBA)
  let matchingPixels = 0;

  // Threshold: a pixel "matches" a brand color if within this RGB distance.
  // 80 is generous — allows for lighting variation, shadows, etc.
  const MATCH_THRESHOLD = 80;

  for (let i = 0; i < data.length; i += channels) {
    const pixel = { r: data[i], g: data[i + 1], b: data[i + 2] };
    // Check if this pixel is close to ANY brand palette color
    if (brandColors.some((bc) => colorDistance(pixel, bc) < MATCH_THRESHOLD)) {
      matchingPixels++;
    }
  }

  return matchingPixels / totalPixels;
}

export class BrandAuditorAgent implements Agent<BrandAuditorInput, BrandCheckResult> {
  readonly name = 'brand-auditor';

  async execute(input: BrandAuditorInput, ctx: RunContext): Promise<BrandCheckResult> {
    const threshold = input.paletteDominanceThreshold ?? 0.3;

    // --- Layer 1: Deterministic palette analysis ---
    const paletteDominance = await analyzePaletteDominance(input.image, input.brandPalette);
    const palettePass = paletteDominance >= threshold;

    // Skip the "palette failed badly" hard-short-circuit when the subject is
    // preserved — the intrinsic product material may dominate the frame and
    // be off-palette by design (kraft tea packaging, copper bottle, etc.).
    // Delegate to the semantic layer, which knows to ignore the product.
    if (!input.preserveSubject && paletteDominance < threshold * 0.5) {
      return {
        verdict: 'fail',
        paletteDominance,
        issues: [
          `Brand palette colors represent only ${(paletteDominance * 100).toFixed(1)}% of the image (threshold: ${(threshold * 100).toFixed(0)}%).`,
        ],
        suggestions: [
          `Increase brand color saturation in the prompt. Add "${input.brandPalette.join(', ')}" as explicit color cues.`,
        ],
      };
    }

    // --- Layer 2: Semantic LLM check ---
    // When a declared product reference must be preserved, the auditor MUST
    // scope palette judgment to scene elements, not the product. Otherwise
    // it contradicts the subject-preservation agent ("palette says remove
    // the kraft brown packaging; subject-preservation says keep it exactly")
    // and the ReAct loop oscillates. Framing is explicit and repeated so
    // the multimodal model doesn't drift mid-reasoning.
    const subjectGuardLines = input.preserveSubject
      ? [
          '',
          '=== PRODUCT MATERIAL EXEMPTION (CRITICAL) ===',
          `The product itself (${input.subjectDescription ?? 'as pictured'}) is being carried`,
          'forward from a declared brief reference. The product may have INTRINSIC colors',
          'that are NOT in the brand palette (e.g., kraft brown packaging, copper material,',
          'natural wood).',
          '',
          'You MUST:',
          '- Evaluate palette compliance on SCENE elements only: background, lighting,',
          '  props, typography, surfaces, surrounding objects.',
          '- NEVER flag the product material, packaging color, or the item itself',
          '  as a palette violation. Those are fixed by the reference.',
          '- If the only palette violation is the product itself, return severity=none',
          '  and paletteUsage=adequate. Do NOT return severity=major or onBrand=false.',
          '- Focus tone assessment on scene mood, composition, and styling — not the',
          '  product color.',
          '=== END EXEMPTION ===',
          '',
        ]
      : [];

    // Text-rendering leniency (hero checks only). Imagen/Gemini-image reliably
    // hallucinates garbled letters when asked to render text on packaging,
    // product surfaces, or scene elements — this is a known limitation, not
    // a fixable output defect. Retrying produces fresh garbled text every
    // time, so `fail` severity here just burns the retry budget. The
    // Composer overlays real, legible campaign copy in a later step — any
    // text baked INTO the hero is going to be replaced or hidden anyway for
    // the headline. Classify text-rendering artifacts as `minor` at worst.
    const textRenderingNoteLines = input.isHeroCheck
      ? [
          '',
          '=== TEXT-RENDERING NOTE ===',
          'AI image generators produce garbled, misspelled, or hallucinated letters',
          'when asked to render text on product packaging, scene objects, or signage.',
          'This is a known model limitation; retries will not fix it — they produce',
          'DIFFERENT garbled text each time. The Composer adds real, legible headline',
          'and body copy on top of this hero image in a later step.',
          '',
          'Therefore, when evaluating THIS hero:',
          '- If garbled/placeholder/hallucinated text appears on packaging or scene',
          '  objects, classify it as severity=minor at most. Do NOT classify as major.',
          '- Note the issue in `issues` so the operator sees it, but do NOT block',
          '  the hero over it.',
          '- Continue to flag layout/composition/palette problems normally.',
          '=== END NOTE ===',
          '',
        ]
      : [];

    const prompt = [
      `You are a brand compliance auditor for a brand with these guidelines:`,
      `- Palette: ${input.brandPalette.join(', ')}`,
      `- Tone: ${input.brandTone ?? 'not specified'}`,
      input.isHeroCheck
        ? `- This is a RAW HERO IMAGE check. The logo is NOT in this image — it will be added in composition. Do not flag logo absence.`
        : `- This is a FINAL CREATIVE check. Logo should be present, text should be readable.`,
      ...subjectGuardLines,
      ...textRenderingNoteLines,
      'Evaluate the image for brand alignment. Return structured feedback.',
    ].join('\n');

    const result = await ctx.adapters.multimodal.analyzeImage({
      image: input.image,
      mimeType: input.mimeType,
      prompt,
      schema: SemanticBrandCheckSchema,
    });

    const semantic = SemanticBrandCheckSchema.parse(JSON.parse(result.text));

    // Combine deterministic + semantic results.
    // When preserveSubject is true, the deterministic palette metric is
    // unreliable (the product's intrinsic colors inflate the non-palette
    // pixel count). Trust the semantic check's judgment instead — it was
    // explicitly told to ignore the product — and demote a deterministic
    // palette miss from blocker to informational.
    const issues = [...semantic.issues];
    if (!palettePass && !input.preserveSubject) {
      issues.unshift(
        `Deterministic palette check: ${(paletteDominance * 100).toFixed(1)}% brand colors (threshold: ${(threshold * 100).toFixed(0)}%)`,
      );
    }

    const paletteBlocks = !palettePass && !input.preserveSubject;
    const verdict =
      semantic.severity === 'major' || paletteBlocks ? 'fail' : semantic.severity === 'minor' ? 'warn' : 'pass';

    return {
      verdict,
      paletteDominance,
      toneMatch: semantic.toneMatch,
      issues,
      suggestions: semantic.suggestionsForRegeneration,
    };
  }
}
