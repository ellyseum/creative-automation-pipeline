/**
 * Brand guide types — loaded from the brief's brand section.
 *
 * These are the runtime-resolved brand assets (bytes loaded from storage),
 * as opposed to the brief's Brand type which just has paths/strings.
 * The BrandAssetBundle is what agents actually receive.
 */

// Loaded brand assets — bytes in memory, ready for composition.
export interface BrandAssetBundle {
  logo: Buffer; // decoded logo image bytes (PNG/SVG)
  palette: string[]; // hex color strings from the brief
  fonts?: {
    display?: Buffer; // display font bytes (TTF/OTF)
    displayPath?: string; // original path (for logging/audit)
    body?: Buffer;
    bodyPath?: string;
  };
  tone?: string; // brand tone descriptor for LLM prompts
  guidelines?: string; // raw text of brand guidelines (for LLM context)
}

// Brand compliance rules — derived from BrandAssetBundle.
// Passed to the Brand Auditor for deterministic + semantic checks.
export interface BrandRules {
  palette: string[]; // expected hex colors
  paletteDominanceThreshold: number; // min % of brand colors in image (default 0.3)
  tone?: string;
  forbidden?: string[]; // forbidden visual styles or elements
}
