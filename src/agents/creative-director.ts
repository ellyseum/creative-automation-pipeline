/**
 * Creative Director agent — the brain of the pipeline.
 *
 * Two-phase approach (tool calling + structured output SEPARATED):
 *
 * Phase 1 (ReAct / tool calling): The director calls search_assets() to
 * explore the brand's asset library. Each search is logged as a sub-invocation.
 * This phase uses tools WITHOUT schema (Gemini 2.5 bug: combining them
 * causes loops/malformed output).
 *
 * Phase 2 (structured output): A clean, single-turn call with the full
 * context (brief + all search results) and JSON schema enforcement.
 * No tools, no multi-turn history. Produces the validated CreativePlan.
 *
 * This separation is the pragmatic solution to a real production constraint:
 * current Gemini models can't reliably combine tool calling and structured
 * output in the same request. Separating them gives us both capabilities
 * with 100% reliability.
 */

import { z } from 'zod';
import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';
import type { Brief } from '../domain/brief.js';
import type { CreativePlan } from '../domain/plan.js';
import type { AssetMatch } from '../domain/asset-metadata.js';

export interface CreativeDirectorInput {
  brief: Brief;
}

// Zod schema for the plan output — forces structured JSON from the LLM
const ProductPlanSchema = z.object({
  productId: z.string(),
  strategy: z.enum(['reuse', 'hybrid', 'generate']),
  assetPath: z.string().optional(),
  assetSimilarity: z.number().optional(),
  referenceAssetPath: z.string().optional(),
  referenceRationale: z.string().optional(),
  generationDirection: z.string().optional(),
  compositionNotes: z.string().optional(),
  rationale: z.string(),
});

const CreativePlanSchema = z.object({
  campaignName: z.string(),
  region: z.string(),
  audience: z.string(),
  products: z.array(ProductPlanSchema),
});

// Tool declaration for search_assets
const searchAssetsTool = {
  name: 'search_assets',
  description:
    'Search the brand asset library for relevant images. Returns up to 5 matches with similarity scores and metadata.',
  parameters: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'Natural-language search query describing the kind of asset you want',
      },
    },
    required: ['query'],
  },
};

export class CreativeDirectorAgent implements Agent<CreativeDirectorInput, CreativePlan> {
  readonly name = 'creative-director';

  async execute(input: CreativeDirectorInput, ctx: RunContext): Promise<CreativePlan> {
    const { brief } = input;

    // ===== PHASE 1: Asset discovery via tool calling (ReAct) =====
    // Let the model search the library with natural-language queries.
    // We collect all search results for Phase 2.
    const allSearchResults = await this.discoverAssets(brief, ctx);

    // Seed declared product assets as pre-ranked candidates. The brief can
    // name specific references per product — we look up their indexed
    // metadata and inject them so Phase 2 sees them as first-class matches
    // rather than hoping a similarity search surfaces them.
    this.injectDeclaredAssets(brief, allSearchResults, ctx);

    // ===== PHASE 2: Plan generation with structured output =====
    // Clean single-turn call with full context + JSON schema enforcement.
    const plan = await this.generatePlan(brief, allSearchResults, ctx);

    // ===== Enforcement pass =====
    // Declared brief assets are authoritative — the user literally named them.
    // Weaker LLMs (flash-lite, etc.) sometimes ignore the "must use hybrid"
    // rule from the prompt and pick "generate" anyway. Coerce any product
    // with declared assets into hybrid with the first declared reference so
    // the semantic is deterministic regardless of LLM compliance.
    this.coerceDeclaredReferences(brief, plan, ctx);

    return plan;
  }

  /**
   * Rewrite any ProductPlan whose product has declared `assets:` in the brief
   * but whose strategy is "generate" (or whose reference isn't one of the
   * declared paths). Keeps the model's generationDirection / compositionNotes
   * intact — only the strategy and referenceAssetPath are coerced.
   */
  private coerceDeclaredReferences(brief: Brief, plan: CreativePlan, ctx: RunContext): void {
    for (const productPlan of plan.products) {
      const product = brief.products.find((p) => p.id === productPlan.productId);
      if (!product?.assets?.length) continue;

      const declared = product.assets;
      const currentRefPath = productPlan.strategy === 'reuse' ? productPlan.assetPath : productPlan.referenceAssetPath;
      const refIsDeclared = currentRefPath && declared.includes(currentRefPath);

      if (productPlan.strategy !== 'hybrid' || !refIsDeclared) {
        const chosen = refIsDeclared ? currentRefPath! : declared[0];
        ctx.logger.warn(
          this.name,
          `Coercing ${product.id} to hybrid with declared reference ${chosen} (LLM chose ${productPlan.strategy}${currentRefPath ? ` with ${currentRefPath}` : ''})`,
        );
        productPlan.strategy = 'hybrid';
        productPlan.referenceAssetPath = chosen;
        productPlan.assetPath = undefined;
        productPlan.assetSimilarity = undefined;
        productPlan.referenceRationale =
          productPlan.referenceRationale ?? `Brief declared ${chosen} as the reference for ${product.id}.`;
        productPlan.generationDirection =
          productPlan.generationDirection ??
          `Preserve the product subject shown in ${chosen}; adapt the scene, lighting, and palette to match the campaign and brand.`;
      }
    }
  }

  /**
   * Phase 1: Use tool calling to let the LLM explore the asset library.
   * Returns accumulated search results for all queries the model made.
   */
  private async discoverAssets(brief: Brief, ctx: RunContext): Promise<Map<string, AssetMatch[]>> {
    const results = new Map<string, AssetMatch[]>();

    const system = [
      'You are a creative director exploring a brand asset library for an upcoming campaign.',
      'Use the search_assets tool to find relevant assets for each product.',
      'Search for product-specific assets AND lifestyle/mood assets that match the campaign tone.',
      'Make 2-4 targeted searches to understand what assets are available.',
    ].join('\n');

    const briefSummary = this.formatBriefSummary(brief);
    const messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string }> = [
      { role: 'user', content: briefSummary },
    ];

    // Max 4 tool-call rounds — enough for 2 products + mood searches
    const MAX_ROUNDS = 4;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const resp = await ctx.adapters.llm.complete({
        system,
        messages,
        tools: [searchAssetsTool],
        // NO schema — tools only. Gemini 2.5 can't combine both.
      });

      // Model returned text — it's done searching
      if (resp.text && !resp.toolCalls?.length) break;

      // Process tool calls
      if (resp.toolCalls?.length) {
        messages.push({ role: 'assistant', content: JSON.stringify(resp.toolCalls) });

        for (const call of resp.toolCalls) {
          if (call.name === 'search_assets') {
            const query = String(call.args.query ?? '');
            ctx.logger.debug(this.name, `search_assets("${query}")`);

            const queryEmbedding = await ctx.adapters.embedding.embed(query);
            const matches = await ctx.adapters.assetIndex.search(query, queryEmbedding, 5);
            results.set(query, matches);

            // Send results back to the conversation
            const formatted = matches.map((m) => ({
              path: m.path,
              similarity: Math.round(m.similarity * 100) / 100,
              description: m.metadata.description,
              mood: m.metadata.mood,
              tags: m.metadata.tags,
            }));

            messages.push({
              role: 'tool',
              content: JSON.stringify(formatted),
              toolCallId: `${call.name}:${call.id}`,
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * Phase 2: Single-turn structured output call to produce the plan.
   * All context (brief + search results) is provided in one prompt.
   * Schema enforcement ensures valid JSON — no tool calling interference.
   */
  private async generatePlan(
    brief: Brief,
    searchResults: Map<string, AssetMatch[]>,
    ctx: RunContext,
  ): Promise<CreativePlan> {
    // Build a comprehensive context including all search results
    const libraryContext = this.formatSearchResults(searchResults);

    const system = [
      'You are a creative director finalizing a campaign plan.',
      'Based on the campaign brief and asset library search results below,',
      'create a per-product creative strategy.',
      '',
      'Strategy rules:',
      '- Declared references (assets the brief explicitly names under a product\'s `assets:` list) are style/subject references for generation, NOT drop-in heroes. If a product has declared references, you MUST choose "hybrid" with the most relevant one as referenceAssetPath and a generationDirection that extracts the key subject (e.g. the product itself) while adapting composition, lighting, and palette to the brand. Never pick "reuse" or "generate" when declared references exist. (Literal drop-in reuse is handled separately via the `hero_asset` field, which the pipeline applies before you run.)',
      '- Otherwise, apply similarity thresholds:',
      '  - "reuse": if a library match has similarity >= 0.85, use it directly. Include assetPath.',
      '  - "hybrid": if best match is 0.6-0.85, use as style reference. Include referenceAssetPath + generationDirection.',
      '  - "generate": if no match above 0.6, generate from scratch. Include generationDirection.',
      '',
      'For ALL strategies: include compositionNotes (where subject is, where text should go).',
      'Include rationale explaining your decision for each product.',
    ].join('\n');

    const userMessage = [
      this.formatBriefSummary(brief),
      '',
      '=== Asset Library Search Results ===',
      libraryContext || '(No assets in library — all products will need generation)',
    ].join('\n');

    const resp = await ctx.adapters.llm.complete({
      system,
      messages: [{ role: 'user', content: userMessage }],
      schema: CreativePlanSchema,
      // NO tools — schema only. Clean structured output.
    });

    return CreativePlanSchema.parse(JSON.parse(resp.text!));
  }

  // For each product that declares `assets:` in the brief, pull their
  // indexed metadata and register them under a synthetic search key so
  // they show up in Phase 2's library context. Similarity is reported as
  // 1.0 because the brief literally named them — they're authoritative.
  private injectDeclaredAssets(brief: Brief, results: Map<string, AssetMatch[]>, ctx: RunContext): void {
    for (const product of brief.products) {
      if (!product.assets?.length) continue;
      const matches: AssetMatch[] = [];
      for (const path of product.assets) {
        const indexed = ctx.adapters.assetIndex.get(path);
        if (!indexed) {
          ctx.logger.warn(
            this.name,
            `Declared asset "${path}" for product ${product.id} is not indexed — skipping injection`,
          );
          continue;
        }
        matches.push({ path, similarity: 1.0, metadata: indexed.metadata });
      }
      if (matches.length) {
        results.set(
          `Declared generation references for product "${product.id}" (use as style/subject reference, NOT drop-in hero)`,
          matches,
        );
      }
    }
  }

  // Format the brief for the LLM prompt
  private formatBriefSummary(brief: Brief): string {
    return [
      `Campaign: ${brief.campaign.name}`,
      `Message: "${brief.campaign.message}"`,
      `Region: ${brief.region}`,
      `Audience: ${brief.audience}`,
      `Brand: ${brief.brand.name} (tone: ${brief.brand.tone ?? 'not specified'})`,
      `Brand palette: ${brief.brand.palette.join(', ')}`,
      '',
      'Products:',
      ...brief.products.flatMap((p) => {
        const heroNote = p.hero_asset
          ? ` (has existing hero: ${p.hero_asset})`
          : ' (no hero — needs retrieval or generation)';
        const lines = [`  - ${p.id}: ${p.name} — ${p.description}${heroNote}`];
        if (p.assets?.length) {
          lines.push(`    declared references: ${p.assets.join(', ')}`);
        }
        return lines;
      }),
    ].join('\n');
  }

  // Format accumulated search results for the planning prompt
  private formatSearchResults(results: Map<string, AssetMatch[]>): string {
    if (results.size === 0) return '';
    const lines: string[] = [];
    for (const [query, matches] of results) {
      lines.push(`Search: "${query}"`);
      if (matches.length === 0) {
        lines.push('  (no matches)');
      } else {
        for (const m of matches) {
          lines.push(`  - ${m.path} (similarity: ${m.similarity.toFixed(2)}) — ${m.metadata.description}`);
        }
      }
      lines.push('');
    }
    return lines.join('\n');
  }
}
