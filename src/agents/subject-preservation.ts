/**
 * Subject Preservation agent — verifies that image-to-image generation
 * actually kept the declared reference's product/subject.
 *
 * Motivation: when the brief declares `assets: [packaging.jpg]` we pass
 * those bytes to Nano Banana as a reference image. But the model has
 * creative latitude — brand-audit retries that say "make it more energetic /
 * change the palette" can nudge it into redesigning the subject rather than
 * recomposing around it. This agent catches that drift by asking a vision
 * LLM to compare the generated hero against the reference.
 *
 * Output mirrors BrandAuditor's shape (verdict + issues + suggestions) so
 * the same ReAct retry loop can consume it without special-casing.
 */

import { z } from 'zod';
import sharp from 'sharp';
import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';

export interface SubjectPreservationInput {
  referenceImage: Buffer;
  referenceMimeType: string;
  generatedImage: Buffer;
  generatedMimeType: string;
  productName: string;
  productDescription: string;
  // The path of the declared reference — useful for audit logs and prompts
  // (the LLM can cite it) but not actually required for the comparison.
  referencePath?: string;
}

export interface SubjectPreservationResult {
  // pass  — the generated image preserves the subject's key identity markers
  // warn  — recognizable but drifted on details (color, label, proportions)
  // fail  — the subject was redesigned or replaced
  verdict: 'pass' | 'warn' | 'fail';
  // Confidence 0..1 that the subject from the reference survived.
  similarity: number;
  issues: string[];
  suggestions: string[];
  rationale: string;
}

const ResultSchema = z.object({
  verdict: z.enum(['pass', 'warn', 'fail']),
  similarity: z
    .number()
    .min(0)
    .max(1)
    .describe('0..1 — how strongly the generated image preserves the reference subject identity'),
  issues: z
    .array(z.string())
    .describe('Concrete ways the subject drifted from the reference (e.g. "packaging redesigned", "logo missing").'),
  suggestions: z
    .array(z.string())
    .describe('Instructions for the next generation pass that would restore subject fidelity.'),
  rationale: z.string().describe('One-paragraph explanation of the verdict.'),
});

export class SubjectPreservationAgent implements Agent<SubjectPreservationInput, SubjectPreservationResult> {
  readonly name = 'subject-preservation';

  async execute(input: SubjectPreservationInput, ctx: RunContext): Promise<SubjectPreservationResult> {
    // Compose the two images side-by-side so a single multimodal call can
    // compare them. Vision LLMs handle a single image-part better than two
    // separate parts — packing them together also keeps token cost lower
    // than making the model ingest both at full size.
    const composite = await buildSideBySide(
      input.referenceImage,
      input.referenceMimeType,
      input.generatedImage,
      input.generatedMimeType,
    );

    // Null (not empty string) for the optional slot, so the final filter
    // drops ONLY the missing conditional — not the intentional blank lines
    // that give the prompt visible section breaks.
    const prompt = [
      `You are verifying subject preservation in image-to-image generation.`,
      `The image below is TWO panels side by side:`,
      `  LEFT panel: the REFERENCE image (the declared product subject the brief named).`,
      `  RIGHT panel: the GENERATED image (the hero produced by the model).`,
      ``,
      `Product: ${input.productName} — ${input.productDescription}`,
      input.referencePath ? `Reference path: ${input.referencePath}` : null,
      ``,
      `Your job: decide whether the RIGHT panel preserves the identity of the product/subject from the LEFT panel.`,
      `- Identity markers that matter: packaging shape, color, labels/branding, material, distinctive proportions.`,
      `- Scene, lighting, composition, and background are allowed (expected) to change.`,
      `- If the product has been RE-DESIGNED (different packaging, different label, different material) that's subject drift.`,
      `- If the product is MISSING entirely (replaced with a generic placeholder), that's a fail.`,
      ``,
      `Output verdict:`,
      `  "pass": key identity markers preserved; scene/lighting adapted as expected.`,
      `  "warn": recognizable but some identity drift (e.g. color shifted, label altered).`,
      `  "fail": subject redesigned, replaced, or absent.`,
      ``,
      `Also produce a similarity score (0..1), concrete issues, and actionable suggestions for the next`,
      `generation pass (what to keep from the reference, what to let the brand audit change).`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    const result = await ctx.adapters.multimodal.analyzeImage({
      image: composite,
      mimeType: 'image/jpeg',
      prompt,
      schema: ResultSchema,
    });

    return ResultSchema.parse(JSON.parse(result.text));
  }
}

// Stitch reference (left) and generated (right) into a single JPEG at a
// uniform height so the vision LLM can compare them in one image part.
async function buildSideBySide(
  leftBytes: Buffer,
  _leftMime: string,
  rightBytes: Buffer,
  _rightMime: string,
): Promise<Buffer> {
  const TARGET_HEIGHT = 768;
  const [left, right] = await Promise.all([
    sharp(leftBytes).resize({ height: TARGET_HEIGHT }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true }),
    sharp(rightBytes).resize({ height: TARGET_HEIGHT }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true }),
  ]);

  const totalWidth = left.info.width + right.info.width + 20; // 20px gutter
  return sharp({
    create: {
      width: totalWidth,
      height: TARGET_HEIGHT,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: left.data, left: 0, top: 0 },
      { input: right.data, left: left.info.width + 20, top: 0 },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
}
