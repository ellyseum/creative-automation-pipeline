/**
 * Hero Generator agent — thin wrapper around the ImageGenerator port.
 *
 * Intentionally minimal — the Prompt Engineer does the hard work of
 * crafting the prompt. This agent just executes the generation call
 * and returns the raw image bytes.
 *
 * The separation exists for audit clarity: the manifest shows exactly
 * which agent produced which artifact, with the generation cost attributed
 * separately from the prompt engineering cost.
 */

import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';
import type { GeneratedImage } from '../ports/image-generator.js';

// Input: the prompt from the Prompt Engineer
export interface HeroGeneratorInput {
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;   // default: "1:1" (square hero, cropped per-ratio later by Composer)
}

// Output: the generated image + metadata for the manifest
export interface HeroGeneratorOutput {
  image: GeneratedImage;
}

export class HeroGeneratorAgent implements Agent<HeroGeneratorInput, HeroGeneratorOutput> {
  readonly name = 'hero-generator';

  async execute(input: HeroGeneratorInput, ctx: RunContext): Promise<HeroGeneratorOutput> {
    // Generate a single hero image — square (1:1) by default.
    // The Composer agent handles aspect-ratio-specific cropping/resizing later.
    const [image] = await ctx.adapters.imageGen.generate({
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      aspectRatio: input.aspectRatio ?? '1:1',
      n: 1,
    });

    // Cost tracking is handled by the orchestrator (which knows the productId).
    // The agent returns the cost estimate in the image metadata.

    return { image };
  }
}
