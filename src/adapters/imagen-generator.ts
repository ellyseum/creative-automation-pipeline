/**
 * Imagen adapter — image generation via Google's Imagen 4 Fast.
 *
 * Uses the same @google/genai SDK as the Gemini LLM adapter.
 * Returns base64-decoded PNG bytes (not URLs — Imagen returns base64 natively).
 * Supports aspect ratio selection: 1:1, 3:4, 4:3, 9:16, 16:9.
 *
 * Cost: ~$0.02 per image (Imagen 4 Fast), cheapest mainstream provider path.
 */

import { GoogleGenAI } from '@google/genai';
import type { ImageGenerator, ImageGenRequest, GeneratedImage } from '../ports/image-generator.js';
import { withRetry } from '../infra/retry.js';
import { imageGenLimit } from '../infra/rate-limiter.js';

// Imagen 4 Fast costs ~$0.02 per image
const COST_PER_IMAGE_USD = 0.02;

export class ImagenGeneratorAdapter implements ImageGenerator {
  readonly name = 'imagen';
  private ai: GoogleGenAI;
  private model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? 'imagen-4.0-fast-generate-001';
  }

  async generate(req: ImageGenRequest): Promise<GeneratedImage[]> {
    // Imagen prefers aspectRatio over explicit width/height.
    // Map our request to the supported ratio format.
    const aspectRatio = req.aspectRatio ?? '1:1';
    const n = Math.min(req.n ?? 1, 4); // Imagen max: 4 images per request

    // LOUD WARN: Imagen 4 Fast is pure text-to-image. It does NOT accept
    // reference images. If a caller (e.g., the hero ReAct loop with a
    // hybrid strategy + declared brief reference) passes referenceImages,
    // they would be silently dropped — the subject-preservation auditor
    // would then correctly report the subject wasn't preserved, and the
    // retry loop would burn its budget chasing an impossible outcome.
    // Emit a one-time warning per call so the mismatch is visible.
    if (req.referenceImages?.length) {
      console.warn(
        `[imagen] ⚠ ${req.referenceImages.length} reference image(s) passed but Imagen 4 Fast does NOT support image conditioning — refs are being IGNORED. Set IMAGE_PROVIDER=gemini-image (Nano Banana) for subject-preservation workflows.`,
      );
    }

    // Guard: process-wide concurrency cap + retry on 429/503. Image gen is
    // priced and rate-limited harder than text LLM calls.
    const resp = await imageGenLimit(() =>
      withRetry(
        () =>
          this.ai.models.generateImages({
            model: this.model,
            prompt: req.prompt,
            config: {
              numberOfImages: n,
              aspectRatio,
              // negativePrompt not directly supported by Imagen 4 — embed in prompt instead
              // seed not supported on the Imagen 4 fast model
            },
          }),
        {
          onRetry: (attempt, delayMs, err) => {
            const status = (err as { status?: unknown; code?: unknown }).status ?? (err as { code?: unknown }).code;
            console.warn(`[imagen] ${status} — retrying in ${delayMs}ms (attempt ${attempt})`);
          },
        },
      ),
    );

    // Decode each generated image from base64 to Buffer
    return (resp.generatedImages ?? []).map((img) => ({
      bytes: Buffer.from(img.image!.imageBytes!, 'base64'),
      mimeType: 'image/png',
      provider: this.name,
      model: this.model,
      costUsdEst: COST_PER_IMAGE_USD,
    }));
  }
}
