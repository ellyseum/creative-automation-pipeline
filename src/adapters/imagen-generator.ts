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
    const n = Math.min(req.n ?? 1, 4);  // Imagen max: 4 images per request

    const resp = await this.ai.models.generateImages({
      model: this.model,
      prompt: req.prompt,
      config: {
        numberOfImages: n,
        aspectRatio,
        // negativePrompt not directly supported by Imagen 4 — embed in prompt instead
        // seed not supported on the Imagen 4 fast model
      },
    });

    // Decode each generated image from base64 to Buffer
    return (resp.generatedImages ?? []).map(img => ({
      bytes: Buffer.from(img.image!.imageBytes!, 'base64'),
      mimeType: 'image/png',
      provider: this.name,
      model: this.model,
      costUsdEst: COST_PER_IMAGE_USD,
    }));
  }
}
