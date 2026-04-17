/**
 * Stub LLM adapter — for running the pipeline without any API keys.
 *
 * Returns plausible but hardcoded responses for each agent's expected output.
 * Useful for: testing pipeline logic, running in CI, demonstrating structure.
 * NOT useful for: evaluating creative quality (that's what real providers are for).
 */

import type {
  LLMClient,
  MultimodalLLMClient,
  EmbeddingClient,
  LLMMessage,
  LLMResponse,
  ToolDeclaration,
} from '../ports/llm-client.js';
import type { ZodType } from 'zod';

// Canned responses — just enough to keep the pipeline flowing.
// Each agent's expected output shape is handled by checking the system prompt.
const CANNED_PLAN = JSON.stringify({
  campaignName: 'Stub Campaign',
  region: 'en-US',
  audience: 'stub audience',
  products: [
    {
      productId: 'solar-flask',
      strategy: 'reuse',
      assetPath: 'assets/products/solar-flask/hero.jpg',
      assetSimilarity: 0.92,
      rationale: 'Stub: matched existing product hero',
      compositionNotes: 'Subject centered, overlay bottom-third',
    },
    {
      productId: 'dawn-brew',
      strategy: 'generate',
      generationDirection: 'Organic tea in a ceramic cup, warm morning light, minimalist',
      rationale: 'Stub: no matching asset found',
      compositionNotes: 'Subject centered, overlay bottom-third',
    },
  ],
});

const CANNED_PROMPT = JSON.stringify({
  prompt: 'Organic tea in a minimalist ceramic cup, warm morning light, shallow depth of field, product photography',
  negativePrompt: 'blurry, low quality, text, watermark',
  reasoning: 'Stub prompt — matches product description and brand tone',
});

const CANNED_BRAND_CHECK = JSON.stringify({
  onBrand: true,
  paletteUsage: 'adequate',
  toneMatch: 'strong',
  issues: [],
  suggestionsForRegeneration: [],
  severity: 'none',
});

const CANNED_ASSET_METADATA = JSON.stringify({
  description: 'Product photo on neutral background, warm tones',
  tags: ['product-shot', 'warm-palette'],
  mood: 'aspirational',
  subjects: ['product'],
  setting: 'studio',
  dominantColors: ['#B87333', '#F5F0E8'],
  brandElements: { logoPresent: false, textPresent: false },
  usageHints: ['hero-ready'],
});

const CANNED_SUBJECT_PRESERVATION = JSON.stringify({
  verdict: 'pass',
  similarity: 0.92,
  issues: [],
  suggestions: [],
  rationale: 'Stub: subject preservation check bypassed in stub mode.',
});

const CANNED_LEGAL = JSON.stringify({
  flags: [],
  verdict: 'clear',
});

const CANNED_LOCALIZED = JSON.stringify({
  localized: 'Level Up Your Morning',
  rationale: 'Source language matches target — no adaptation needed.',
});

const CANNED_REPORT = JSON.stringify({
  markdown:
    '# Stub Report\n\nPipeline ran in stub mode. All outputs are placeholders.\n\n- Products: 2\n- Creatives: 6\n- Cost: $0.00\n',
});

export class StubLLMAdapter implements LLMClient, MultimodalLLMClient, EmbeddingClient {
  readonly name = 'stub-llm';

  async complete(opts: {
    system: string;
    messages: LLMMessage[];
    schema?: ZodType;
    tools?: ToolDeclaration[];
    forceToolUse?: boolean;
  }): Promise<LLMResponse> {
    // Detect which agent is calling based on system prompt keywords
    const sys = opts.system.toLowerCase();
    let text: string;

    if (sys.includes('creative director') || sys.includes('search_assets')) {
      // If tools are defined and first call, return a tool call to simulate search
      if (opts.tools?.length && !opts.messages.some((m) => m.role === 'tool')) {
        return {
          toolCalls: [{ id: 'stub-call-1', name: 'search_assets', args: { query: 'product hero photo' } }],
          tokens: { prompt: 100, completion: 20 },
          model: 'stub',
        };
      }
      text = CANNED_PLAN;
    } else if (sys.includes('prompt engineer')) {
      text = CANNED_PROMPT;
    } else if (sys.includes('localization') || sys.includes('localiz')) {
      text = CANNED_LOCALIZED;
    } else if (sys.includes('report') || sys.includes('executive')) {
      text = CANNED_REPORT;
    } else {
      text = '{"result": "stub response"}';
    }

    return { text, tokens: { prompt: 50, completion: 30 }, model: 'stub' };
  }

  async analyzeImage(opts: {
    image: Buffer;
    mimeType: string;
    prompt: string;
    schema?: ZodType;
  }): Promise<{ text: string; tokens: { prompt: number; completion: number }; model: string }> {
    const p = opts.prompt.toLowerCase();

    let text: string;
    // Order matters: more specific matches first to avoid false positives.
    // "cataloging assets for brand X" contains "brand" but should match catalog, not audit.
    if (p.includes('catalog') || p.includes('asset library')) {
      text = CANNED_ASSET_METADATA;
    } else if (p.includes('subject preservation') || p.includes('left panel') || p.includes('right panel')) {
      text = CANNED_SUBJECT_PRESERVATION;
    } else if (p.includes('legal') || p.includes('regulatory')) {
      text = CANNED_LEGAL;
    } else if (p.includes('brand') || p.includes('compliance') || p.includes('auditor')) {
      text = CANNED_BRAND_CHECK;
    } else {
      text = CANNED_ASSET_METADATA;
    }

    return { text, tokens: { prompt: 100, completion: 50 }, model: 'stub' };
  }

  async embed(input: string, opts?: { dimensions?: number }): Promise<number[]> {
    // Generate a deterministic pseudo-random embedding from the input string.
    // Same input always produces the same vector — enables consistent test results.
    const dims = opts?.dimensions ?? 768;
    const vec: number[] = [];
    let seed = 0;
    for (const ch of input) seed = ((seed << 5) - seed + ch.charCodeAt(0)) | 0;
    for (let i = 0; i < dims; i++) {
      seed = (seed * 1103515245 + 12345) | 0;
      vec.push(((seed >> 16) & 0x7fff) / 0x7fff - 0.5); // range: -0.5 to 0.5
    }
    // Normalize to unit length
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / mag);
  }
}
