/**
 * Campaign brief schema — the primary input to the pipeline.
 *
 * Validated with zod so malformed YAML fails fast with useful errors
 * rather than silently producing garbage downstream. Every field maps
 * to a specific agent's input requirements.
 */

import { z } from 'zod';

// --- Brand definition ---
// Brand assets are loaded once per run and reused across every creative.
// Logo and palette are required — without them, brand compliance is impossible.

export const BrandSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  logo: z.string().min(1),                              // path to logo in storage
  palette: z.array(z.string().regex(/^#[0-9A-Fa-f]{6}$/)).min(1),  // hex colors
  fonts: z.object({
    display: z.string().min(1),                          // path to display font (TTF/OTF)
    body: z.string().optional(),                         // path to body font (optional)
  }).optional(),
  tone: z.string().optional(),                           // e.g., "energetic, minimal, health-forward"
  guidelines: z.string().optional(),                     // path to brand guidelines doc (for LLM context)
});

// --- Campaign definition ---
// Campaign-level fields apply to all products in this brief.

export const CampaignSchema = z.object({
  name: z.string().min(1),
  message: z.string().min(1).max(200),                   // the headline — rendered on every creative
  mood_reference: z.string().optional(),                 // optional mood/reference image path
});

// --- Product definition ---
// Each product gets its own set of creatives across all aspect ratios.
// hero_asset is optional — if missing, the pipeline generates one via GenAI.

export const ProductSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Product ID must be alphanumeric/dash/underscore'),
  name: z.string().min(1),
  description: z.string().min(1),
  hero_asset: z.string().optional(),                     // path to existing hero image — reused when available
});

// --- Full brief ---
// The brief must have at least 2 products (per assignment requirements).

export const BriefSchema = z.object({
  brand: BrandSchema,
  campaign: CampaignSchema,
  region: z.string().min(2).max(10),                     // e.g., "en-US", "ja-JP"
  audience: z.string().min(1),                           // e.g., "millennials, urban, health-conscious"
  products: z.array(ProductSchema).min(2, 'Brief must include at least 2 products'),
  aspect_ratios: z.array(z.string()).optional(),         // override default ["1:1", "9:16", "16:9"]
});

// --- Inferred TypeScript types ---
export type Brand = z.infer<typeof BrandSchema>;
export type Campaign = z.infer<typeof CampaignSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Brief = z.infer<typeof BriefSchema>;

// Default aspect ratios if not overridden in the brief
export const DEFAULT_ASPECT_RATIOS = ['1:1', '9:16', '16:9'] as const;
