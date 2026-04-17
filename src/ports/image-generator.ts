/**
 * Image generator port — what the pipeline needs from a diffusion model.
 *
 * Adapters: ImagenGenerator (default), FireflyGenerator (prod target),
 * OpenAI (fallback), StubGenerator (local mode — returns placeholder).
 *
 * Returns raw bytes, not URLs. This is intentional — some providers
 * (Imagen) return base64, others (Firefly) return pre-signed URLs
 * that expire in 1 hour. The adapter normalizes to bytes so the
 * pipeline never worries about URL lifecycle.
 */

export interface ImageGenRequest {
  prompt: string;
  negativePrompt?: string; // what to avoid in generation
  width?: number; // default: 1024
  height?: number; // default: 1024
  aspectRatio?: string; // "1:1", "9:16", "16:9" — provider may prefer this over explicit w/h
  n?: number; // number of variations (default: 1)
  seed?: number; // for reproducibility (if provider supports it)
}

export interface GeneratedImage {
  bytes: Buffer; // decoded PNG/JPEG bytes — never a URL
  mimeType: string; // "image/png" | "image/jpeg"
  provider: string; // which provider generated this: "imagen", "firefly", "openai"
  model: string; // specific model: "imagen-4.0-fast-generate-001"
  costUsdEst: number; // estimated cost of this single generation
  seed?: number; // seed used (for reproducibility)
}

export interface ImageGenerator {
  readonly name: string;

  // Generate one or more images from a prompt.
  generate(req: ImageGenRequest): Promise<GeneratedImage[]>;
}
