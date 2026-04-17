/**
 * Creative output types — what the pipeline produces.
 *
 * A Creative is one final composited image: a specific product × aspect ratio
 * with the campaign message overlaid, brand elements applied, and compliance
 * checks recorded. A Variant groups the aspect-ratio-specific outputs per product.
 */

// Aspect ratio targets — each produces a different-sized creative.
// Dimensions match standard social media specs.
export interface AspectRatioSpec {
  label: string; // display label: "1:1", "9:16", "16:9"
  width: number; // output width in pixels
  height: number; // output height in pixels
  platform: string; // primary platform: "Instagram Feed", "Stories/Reels", "YouTube/Display"
}

// Standard aspect ratio definitions.
// Platform-aware safe zones are applied by the Composer agent.
export const ASPECT_RATIOS: Record<string, AspectRatioSpec> = {
  '1:1': { label: '1:1', width: 1080, height: 1080, platform: 'Instagram/Facebook Feed' },
  '9:16': { label: '9:16', width: 1080, height: 1920, platform: 'Stories/Reels/TikTok' },
  '16:9': { label: '16:9', width: 1920, height: 1080, platform: 'YouTube/Display/LinkedIn' },
};

// One composited creative — the atomic output unit.
export interface Creative {
  productId: string;
  aspectRatio: string; // "1:1", "9:16", "16:9"
  outputPath: string; // relative path in output folder
  heroSource: 'input' | 'generated' | 'retrieved';
  heroPath: string; // path to the hero image used
  textRendered: string; // the actual text overlaid (may be localized)
  compositionDetails: {
    template: string; // which placement template was used
    overridesApplied: string[]; // which overrides (director hints, retry hints) were applied
    zoneCoordsY: number; // text zone Y position
    barOpacity: number; // semi-transparent bar opacity used
    fontSize: number; // font size rendered
    logoCoordsX: number; // logo X position
    logoCoordsY: number; // logo Y position
  };
}

// Brand compliance result attached to each creative.
export interface BrandCheckResult {
  verdict: 'pass' | 'warn' | 'fail';
  paletteDominance?: number; // 0–1, percentage of brand colors in image
  logoPresent?: boolean;
  toneMatch?: 'strong' | 'adequate' | 'weak' | 'off';
  issues: string[];
  suggestions: string[];
}

// Legal compliance result attached to each creative.
export interface LegalCheckResult {
  verdict: 'clear' | 'review_needed' | 'blocked';
  flags: Array<{
    type: 'health_claim' | 'implied_guarantee' | 'comparative' | 'prohibited_word';
    text: string;
    severity: 'low' | 'medium' | 'high';
  }>;
}

// Per-product variant set — all aspect ratios for one product.
export interface ProductVariants {
  productId: string;
  heroSource: 'input' | 'generated' | 'retrieved';
  heroPath: string;
  generation?: {
    provider: string;
    model: string;
    prompt: string;
    costUsdEst: number;
    durationMs: number;
  };
  retrieval?: {
    query: string;
    topMatches: Array<{ path: string; similarity: number }>;
    decision: string;
  };
  variants: Array<{
    creative: Creative;
    brandCheck: BrandCheckResult;
    legalCheck: LegalCheckResult;
    retries: number;
  }>;
}
