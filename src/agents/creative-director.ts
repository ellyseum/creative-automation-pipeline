/**
 * Creative Director agent — the brain of the pipeline.
 *
 * This is the agentic pattern the JD calls out: a tool-using LLM that
 * reasons over a campaign brief and the brand's asset library to produce
 * a per-product creative strategy.
 *
 * The director has access to search_assets() as a callable tool (function
 * calling / ReAct). During planning, it queries the library with natural-
 * language searches — "find me autumn-themed product shots" — and uses the
 * results to decide per product:
 *
 *   - REUSE: library has a high-confidence match (≥0.85) → use as-is
 *   - HYBRID: medium match (0.6–0.85) → use as style reference for generation
 *   - GENERATE: no usable match → generate from scratch via Prompt Engineer
 *
 * This decision IS the economic lever: reuse is nearly free, generation costs money.
 * The manifest records which strategy was chosen per product for cost attribution.
 */

import { z } from 'zod';
import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';
import type { Brief } from '../domain/brief.js';
import type { CreativePlan, ProductPlan } from '../domain/plan.js';

// Input to the Creative Director: the parsed brief
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

export class CreativeDirectorAgent implements Agent<CreativeDirectorInput, CreativePlan> {
  readonly name = 'creative-director';

  async execute(input: CreativeDirectorInput, ctx: RunContext): Promise<CreativePlan> {
    const { brief } = input;

    // Build the system prompt — gives the director its role and decision framework.
    const system = [
      'You are a creative director planning a social ad campaign.',
      'For each product in the brief, decide the best creative strategy.',
      '',
      'You have access to a function `search_assets(query)` that searches the brand\'s',
      'asset library and returns up to 5 relevant matches with similarity scores (0–1).',
      '',
      'Strategy rules:',
      '- "reuse": if a library match has similarity ≥ 0.85, use it directly as the hero image.',
      '- "hybrid": if best match is 0.6–0.85, use it as a style reference for generation.',
      '- "generate": if no match above 0.6, generate a new hero from scratch.',
      '',
      'For "reuse": include the asset path and similarity score.',
      'For "hybrid": include the reference asset path and a description of why it works as a reference.',
      'For "generate" and "hybrid": include detailed generation_direction for the prompt engineer.',
      'For ALL strategies: include composition_notes (where is the subject, where should text go).',
      '',
      'Call search_assets() as many times as needed. Make a confident plan.',
      'Return the final plan as a CreativePlan JSON object.',
    ].join('\n');

    // Build the user message — the brief details
    const briefSummary = [
      `Campaign: ${brief.campaign.name}`,
      `Message: "${brief.campaign.message}"`,
      `Region: ${brief.region}`,
      `Audience: ${brief.audience}`,
      `Brand: ${brief.brand.name} (tone: ${brief.brand.tone ?? 'not specified'})`,
      `Brand palette: ${brief.brand.palette.join(', ')}`,
      '',
      'Products:',
      ...brief.products.map(p =>
        `  - ${p.id}: ${p.name} — ${p.description}${p.hero_asset ? ` (has hero: ${p.hero_asset})` : ' (no hero — needs retrieval or generation)'}`
      ),
    ].join('\n');

    // Tool declaration for search_assets — Gemini will call this during reasoning
    const searchAssetsTool = {
      name: 'search_assets',
      description: 'Search the brand asset library for relevant images. Returns up to 5 matches with similarity scores and metadata descriptions.',
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

    // Conversation loop — the director may call search_assets multiple times (ReAct).
    // Each tool call round-trip is a separate turn in the conversation.
    const messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string }> = [
      { role: 'user', content: briefSummary },
    ];

    // Max 5 tool-call rounds to prevent runaway loops
    const MAX_ROUNDS = 5;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const resp = await ctx.adapters.llm.complete({
        system,
        messages,
        tools: [searchAssetsTool],
        // Don't force tool use — let the model decide when it has enough info
        schema: round === MAX_ROUNDS - 1 ? CreativePlanSchema : undefined,
      });

      // If the model returned text (no tool calls), it's done planning
      if (resp.text && !resp.toolCalls?.length) {
        const plan = CreativePlanSchema.parse(JSON.parse(resp.text));
        return plan;
      }

      // Process tool calls — execute search_assets for each one
      if (resp.toolCalls?.length) {
        // Add the assistant's turn (with tool calls) to conversation history
        messages.push({
          role: 'assistant',
          content: JSON.stringify(resp.toolCalls),
        });

        for (const call of resp.toolCalls) {
          if (call.name === 'search_assets') {
            const query = String(call.args.query ?? '');
            ctx.logger.debug(this.name, `search_assets("${query}")`);

            // Execute the actual vector search against the asset index
            const queryEmbedding = await ctx.adapters.embedding.embed(query);
            const matches = await ctx.adapters.assetIndex.search(query, queryEmbedding, 5);

            // Format results for the LLM — includes path, similarity, and description
            const resultsForLLM = matches.map(m => ({
              path: m.path,
              similarity: Math.round(m.similarity * 100) / 100,
              description: m.metadata.description,
              mood: m.metadata.mood,
              tags: m.metadata.tags,
            }));

            // Send tool result back to the conversation
            messages.push({
              role: 'tool',
              content: JSON.stringify(resultsForLLM),
              toolCallId: `${call.name}:${call.id}`,
            });
          }
        }
      }
    }

    // Fallback: if the director ran out of rounds, ask for final plan directly
    ctx.logger.warn(this.name, 'Director hit max tool-call rounds, forcing final output');
    const finalResp = await ctx.adapters.llm.complete({
      system: system + '\n\nYou must return your final CreativePlan now. No more tool calls.',
      messages,
      schema: CreativePlanSchema,
    });

    return CreativePlanSchema.parse(JSON.parse(finalResp.text!));
  }
}
