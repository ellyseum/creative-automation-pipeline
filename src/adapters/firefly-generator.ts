/**
 * Adobe Firefly Services adapter — the PRODUCTION target for Adobe customers.
 *
 * Real SDK code using @adobe/firefly-apis. Implements the same ImageGenerator
 * interface as Imagen/OpenAI. The pipeline doesn't know which provider it's using.
 *
 * Requires enterprise IMS credentials (ADOBE_CLIENT_ID + ADOBE_CLIENT_SECRET).
 * Without them, the factory falls back to Imagen. This adapter exists to show:
 * 1. We know Firefly Services API exists and how it works
 * 2. The adapter pattern makes swapping trivial
 * 3. The production path for an Adobe customer is ready to wire
 *
 * GOTCHA: Firefly returns pre-signed URLs that expire in 1 hour.
 * The adapter fetches and buffers the image immediately so downstream
 * code never deals with URL lifecycle management.
 */

import type { ImageGenerator, ImageGenRequest, GeneratedImage } from '../ports/image-generator.js';
import { withRetry } from '../infra/retry.js';
import { imageGenLimit } from '../infra/rate-limiter.js';

// Estimated cost per Firefly premium generation (varies by operation)
const COST_PER_IMAGE_USD = 0.08;

export class FireflyGeneratorAdapter implements ImageGenerator {
  readonly name = 'firefly';
  private clientId: string;
  private clientSecret: string;

  constructor(opts: { clientId: string; clientSecret: string }) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
  }

  async generate(req: ImageGenRequest): Promise<GeneratedImage[]> {
    // Dynamic import — @adobe/firefly-apis is an optional dependency.
    // This avoids a hard crash if the package isn't installed.
    let FireflyClient: any;
    try {
      const mod = await import('@adobe/firefly-apis');
      FireflyClient = mod.FireflyClient;
    } catch {
      throw new Error(
        'FireflyProvider requires @adobe/firefly-apis. Install with: npm install @adobe/firefly-apis @adobe/firefly-services-common-apis',
      );
    }

    // Constructor-based auth — auto-refreshes tokens internally.
    // Scopes: firefly_api (image gen), ff_apis (expanded ops).
    const client = new FireflyClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      scopes: 'firefly_api,ff_apis',
    });

    // Guard: process-wide concurrency cap + retry on 429/503. Firefly gets
    // the same imageGenLimit pool as Imagen since they swap in/out via factory.
    const resp: any = await imageGenLimit(() =>
      withRetry(
        () =>
          client.generateImages({
            prompt: req.prompt,
            numVariations: req.n ?? 1,
            size: req.width && req.height ? { width: req.width, height: req.height } : { width: 1024, height: 1024 },
            negativePrompt: req.negativePrompt,
            contentClass: 'photo', // optimize for photographic output
          }),
        {
          onRetry: (attempt, delayMs, err) => {
            const status = (err as { status?: unknown; code?: unknown }).status ?? (err as { code?: unknown }).code;
            console.warn(`[firefly] ${status} — retrying in ${delayMs}ms (attempt ${attempt})`);
          },
        },
      ),
    );

    // Firefly returns pre-signed URLs that expire in 1 hour.
    // We fetch immediately and convert to Buffer so the pipeline
    // never has to worry about URL expiry.
    const images: GeneratedImage[] = [];
    for (const output of resp.result.outputs) {
      // output.image is a PublicBinaryOutput with a URL property
      const imageUrl = (output.image as any)?.url;
      if (!imageUrl) continue;

      // Fetch the image bytes before the URL expires
      const fetchResp = await fetch(imageUrl);
      if (!fetchResp.ok) throw new Error(`Failed to fetch Firefly image: ${fetchResp.status}`);
      const bytes = Buffer.from(await fetchResp.arrayBuffer());

      images.push({
        bytes,
        mimeType: 'image/jpeg', // Firefly returns JPEG by default
        provider: this.name,
        model: 'firefly-v3',
        costUsdEst: COST_PER_IMAGE_USD,
        seed: output.seed,
      });
    }

    return images;
  }
}
