/**
 * Gemini Image adapter — image generation via Nano Banana (Pro / Flash).
 *
 * Uses the same @google/genai SDK as the Gemini LLM adapter. Unlike Imagen,
 * this model accepts reference images in the same `generateContent` call —
 * enabling image-to-image / subject-preservation workflows. When the brief
 * declares product assets (e.g. `packaging.jpg`), the pipeline passes the
 * actual bytes as a reference so the generated hero keeps the real product
 * rather than hallucinating a lookalike.
 *
 * Default model: gemini-3-pro-image-preview (Nano Banana Pro).
 * Override via GEMINI_IMAGE_MODEL (e.g. gemini-3.1-flash-image-preview).
 */

import { GoogleGenAI } from '@google/genai';
import type { ImageGenerator, ImageGenRequest, GeneratedImage } from '../ports/image-generator.js';
import { withRetry, defaultIsRetryable } from '../infra/retry.js';
import { imageGenLimit } from '../infra/rate-limiter.js';

// Nano Banana Pro costs ~$0.04 per image (2x Imagen 4 Fast).
// Flash variant is ~$0.02 — same as Imagen, but with reference-image support.
const COST_PER_IMAGE_USD_PRO = 0.04;
const COST_PER_IMAGE_USD_FLASH = 0.02;

export class GeminiImageGeneratorAdapter implements ImageGenerator {
  readonly name = 'gemini-image';
  private ai: GoogleGenAI;
  private model: string;
  // Fallback chain for 503 UNAVAILABLE — Nano Banana Pro is capacity-limited,
  // step down to the Flash variant (still supports reference images) before
  // surfacing the failure to the pipeline.
  private fallbackModels: string[];

  constructor(opts: { apiKey: string; model?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? process.env.GEMINI_IMAGE_MODEL ?? 'gemini-3-pro-image-preview';
    const fbRaw = process.env.GEMINI_IMAGE_MODEL_FALLBACKS ?? 'gemini-3.1-flash-image-preview';
    this.fallbackModels = fbRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== this.model);
  }

  // Sticky-failover pointer — see gemini-llm.ts for rationale.
  private stickyStartIndex = 0;

  async generate(req: ImageGenRequest): Promise<GeneratedImage[]> {
    const aspectRatio = req.aspectRatio ?? '1:1';

    // Multimodal content: optional reference images first, then the text
    // prompt. Gemini image models use the same generateContent API as the
    // text LLM — references are just additional inlineData parts.
    const parts: Array<Record<string, unknown>> = [];
    const refSummaries: Array<{ bytes: number; mimeType: string }> = [];
    if (req.referenceImages?.length) {
      for (const ref of req.referenceImages) {
        // Defensive: guard against a zero-byte buffer slipping through. If
        // the reference is empty, the API call technically succeeds but the
        // model has nothing to condition on — we'd silently lose subject
        // preservation. Better to fail loud here.
        if (!ref.bytes?.length) {
          throw new Error(`gemini-image: reference image has no bytes (mimeType=${ref.mimeType})`);
        }
        parts.push({
          inlineData: {
            mimeType: ref.mimeType,
            data: ref.bytes.toString('base64'),
          },
        });
        refSummaries.push({ bytes: ref.bytes.length, mimeType: ref.mimeType });
      }
      console.log(
        `[gemini-image] passing ${refSummaries.length} reference image(s): ${refSummaries
          .map((r) => `${(r.bytes / 1024).toFixed(1)}KB ${r.mimeType}`)
          .join(', ')}`,
      );
    }
    parts.push({ text: req.prompt });

    const chain = [this.model, ...this.fallbackModels];
    const startAt = Math.min(this.stickyStartIndex, chain.length - 1);
    let resp;
    let modelUsed = this.model;
    let lastErr: unknown;
    for (let i = startAt; i < chain.length; i++) {
      const isLast = i === chain.length - 1;
      modelUsed = chain[i];
      const callModel = () =>
        this.ai.models.generateContent({
          model: modelUsed,
          contents: [{ role: 'user', parts }],
          config: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio },
          } as Record<string, unknown>,
        });
      try {
        // Only the final model in the chain gets retries — earlier models
        // fail fast on 503 so we move to the next variant quickly.
        resp = await imageGenLimit(() =>
          isLast
            ? withRetry(callModel, {
                onRetry: (attempt, delayMs, err) => {
                  const status =
                    (err as { status?: unknown; code?: unknown }).status ?? (err as { code?: unknown }).code;
                  console.warn(`[gemini-image:${modelUsed}] ${status} — retrying in ${delayMs}ms (attempt ${attempt})`);
                },
              })
            : callModel(),
        );
        break;
      } catch (err) {
        lastErr = err;
        if (!defaultIsRetryable(err) || isLast) throw err;
        if (i + 1 > this.stickyStartIndex) this.stickyStartIndex = i + 1;
        const status = err as { status?: unknown; code?: unknown; message?: unknown };
        const label = String(status.status ?? status.code ?? status.message ?? 'error');
        console.warn(`[gemini-image] ${modelUsed} failed (${label}) — falling back to ${chain[i + 1]} (sticky)`);
      }
    }
    if (!resp) throw lastErr;

    // Pull every image part out of the response. The SDK returns candidates
    // with parts containing inlineData for images.
    const images: GeneratedImage[] = [];
    const candidates = resp.candidates ?? [];
    const costPerImage = modelUsed.includes('flash') ? COST_PER_IMAGE_USD_FLASH : COST_PER_IMAGE_USD_PRO;
    for (const cand of candidates) {
      for (const part of cand.content?.parts ?? []) {
        const inline = (part as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
        if (inline?.data) {
          images.push({
            bytes: Buffer.from(inline.data, 'base64'),
            mimeType: inline.mimeType ?? 'image/png',
            provider: this.name,
            model: modelUsed,
            costUsdEst: costPerImage,
          });
        }
      }
    }

    if (images.length === 0) {
      throw new Error('gemini-image returned no image parts');
    }
    return images;
  }
}
