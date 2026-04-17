/**
 * Stub image generator — for local runs without any API keys.
 *
 * Produces a solid-color PNG with the prompt text rendered on it.
 * Useful for: testing the pipeline logic, running in CI without keys,
 * demonstrating the output folder structure without burning API credits.
 *
 * The output is deliberately ugly — it's a stub, not a substitute.
 * When the demo shows real Imagen-generated images vs. these stubs,
 * the difference makes the GenAI value proposition self-evident.
 */

import sharp from 'sharp';
import type { ImageGenerator, ImageGenRequest, GeneratedImage } from '../ports/image-generator.js';

// Generate a placeholder image: solid background + prompt text via SVG overlay
async function makePlaceholder(prompt: string, width: number, height: number): Promise<Buffer> {
  // Create a solid color background (dark gray)
  const bg = sharp({
    create: { width, height, channels: 4, background: { r: 40, g: 40, b: 40, alpha: 1 } },
  });

  // SVG text overlay with the prompt (truncated to fit)
  const truncated = prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt;
  const svg = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="none" stroke="#666" stroke-width="4" stroke-dasharray="20,10" />
      <text x="50%" y="45%" font-family="monospace" font-size="24" fill="#aaa"
            text-anchor="middle" dominant-baseline="middle">[STUB IMAGE]</text>
      <text x="50%" y="55%" font-family="monospace" font-size="14" fill="#888"
            text-anchor="middle" dominant-baseline="middle">${escapeXml(truncated)}</text>
    </svg>
  `);

  return bg
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

// Escape special XML characters in text for SVG embedding
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class StubGeneratorAdapter implements ImageGenerator {
  readonly name = 'stub';

  async generate(req: ImageGenRequest): Promise<GeneratedImage[]> {
    const width = req.width ?? 1024;
    const height = req.height ?? 1024;
    const n = req.n ?? 1;

    const images: GeneratedImage[] = [];
    for (let i = 0; i < n; i++) {
      images.push({
        bytes: await makePlaceholder(req.prompt, width, height),
        mimeType: 'image/png',
        provider: this.name,
        model: 'stub',
        costUsdEst: 0,
      });
    }
    return images;
  }
}
