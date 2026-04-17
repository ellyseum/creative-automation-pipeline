/**
 * Creative plan — output of the Creative Director agent.
 *
 * The plan describes per-product strategy: should we reuse an existing
 * asset from the library, use one as a style reference for generation,
 * or generate from scratch? This decision drives the entire downstream
 * pipeline and is the core economic lever — reuse is nearly free,
 * generation costs money.
 */

// Three strategies the Creative Director can choose per product.
// Each carries different cost and quality implications.
export type ProductStrategy = 'reuse' | 'hybrid' | 'generate';

// Per-product plan entry — one per product in the brief.
export interface ProductPlan {
  productId: string; // matches Product.id in the brief
  strategy: ProductStrategy;

  // For 'reuse': the asset path that matched with high confidence
  assetPath?: string;
  assetSimilarity?: number; // 0–1 similarity score from retrieval

  // For 'hybrid': a reference asset to anchor the generation style
  referenceAssetPath?: string;
  referenceRationale?: string; // why this reference was chosen

  // For 'generate' and 'hybrid': the creative direction for the Prompt Engineer
  generationDirection?: string; // prose describing what to generate

  // Composition hints for the Composer agent (aspect-ratio-specific placement)
  compositionNotes?: string; // e.g., "subject centered, overlay bottom-third"

  // Director's reasoning — recorded for audit trail
  rationale: string;
}

// The full creative plan produced by the Creative Director.
export interface CreativePlan {
  campaignName: string;
  region: string;
  audience: string;
  products: ProductPlan[];
}
