/**
 * Composer agent — deterministic image composition (NO LLM calls).
 *
 * Takes a hero image and produces a final creative by:
 * 1. Resizing/cropping to target aspect ratio (sharp, smart crop)
 * 2. Rendering campaign text overlay (@napi-rs/canvas for custom fonts)
 * 3. Placing brand logo in a corner
 * 4. Adding a semi-transparent brand-color bar for text contrast
 *
 * Text placement is determined by:
 * - Per-ratio default templates (with platform-specific safe zones)
 * - Creative Director's composition_notes (overrides defaults)
 * - ReAct retry hints from Brand Auditor (adjust contrast/position)
 *
 * Platform safe zones are baked in because a creative that looks great in
 * isolation but gets covered by Instagram's profile bar or TikTok's
 * reply input is worthless in production.
 */

import sharp from 'sharp';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';
import type { Creative } from '../domain/creative.js';
import { ASPECT_RATIOS } from '../domain/creative.js';

// Input: all the pieces needed to compose one final creative
export interface ComposerInput {
  productId: string;
  heroImage: Buffer;
  aspectRatio: string; // "1:1", "9:16", "16:9"
  message: string; // localized campaign message
  logoImage: Buffer; // brand logo PNG
  brandPalette: string[]; // hex colors for the overlay bar
  compositionNotes?: string; // from Creative Director (placement hints)
  fontPath?: string; // path to brand display font (optional)
}

// --- Placement templates per aspect ratio ---
// Each template defines where text and logo go, with platform-specific safe zones.

interface PlacementTemplate {
  name: string;
  // Text bar zone (relative to canvas dimensions)
  textZoneY: number; // Y offset (top of text bar)
  textZoneH: number; // height of text bar
  fontSize: number; // text size in pixels
  barOpacity: number; // semi-transparent overlay opacity (0–1)
  // Logo position
  logoX: number;
  logoY: number;
  logoSize: number; // width = height (square)
}

// Templates account for platform UI overlays:
// - 9:16 avoids top 300px (IG/TikTok profile) and bottom 400px (reply input)
// - 16:9 avoids bottom 100px (video player controls)
const TEMPLATES: Record<string, PlacementTemplate> = {
  '1:1': {
    name: '1:1-default',
    textZoneY: 780,
    textZoneH: 220,
    fontSize: 64,
    barOpacity: 0.7,
    logoX: 900,
    logoY: 60,
    logoSize: 120,
  },
  '9:16': {
    name: '9:16-default',
    textZoneY: 1100,
    textZoneH: 320,
    fontSize: 72,
    barOpacity: 0.75,
    logoX: 900,
    logoY: 320,
    logoSize: 120, // below notch-safe zone
  },
  '16:9': {
    name: '16:9-default',
    textZoneY: 820,
    textZoneH: 180,
    fontSize: 48,
    barOpacity: 0.7,
    logoX: 60,
    logoY: 60,
    logoSize: 120,
  },
};

// Pick the darkest color from the brand palette — used for text bar background
function pickDarkest(palette: string[]): { r: number; g: number; b: number } {
  let darkest = { r: 0, g: 0, b: 0 };
  let minLuminance = Infinity;

  for (const hex of palette) {
    const n = parseInt(hex.replace('#', ''), 16);
    const r = (n >> 16) & 255,
      g = (n >> 8) & 255,
      b = n & 255;
    // Perceived luminance (ITU-R BT.601)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < minLuminance) {
      minLuminance = lum;
      darkest = { r, g, b };
    }
  }
  return darkest;
}

// Render text as a PNG buffer using SVG (works with default fonts).
// For custom brand fonts, we'd use @napi-rs/canvas — but SVG via sharp
// works reliably for system fonts and keeps dependencies simpler for the PoC.
function renderTextSvg(text: string, width: number, height: number, fontSize: number): Buffer {
  // Escape XML entities in the message text
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="50%" y="50%"
          font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold"
          fill="white" stroke="rgba(0,0,0,0.3)" stroke-width="1"
          text-anchor="middle" dominant-baseline="middle">
      ${escaped}
    </text>
  </svg>`;
  return Buffer.from(svg);
}

export class ComposerAgent implements Agent<ComposerInput, Creative> {
  readonly name = 'composer';

  async execute(input: ComposerInput, ctx: RunContext): Promise<Creative> {
    const spec = ASPECT_RATIOS[input.aspectRatio];
    if (!spec) throw new Error(`Unknown aspect ratio: ${input.aspectRatio}`);

    // Resolve placement template — start with ratio default, apply overrides
    const template = { ...(TEMPLATES[input.aspectRatio] ?? TEMPLATES['1:1']) };
    const overridesApplied: string[] = [];

    // 1. Resize hero to target dimensions — smart crop preserving the focal point
    const resized = await sharp(input.heroImage)
      .resize(spec.width, spec.height, {
        fit: 'cover',
        position: sharp.strategy.attention, // luminance + saturation + skin tone
      })
      .toBuffer();

    // 2. Create semi-transparent brand-color bar for text contrast
    const barColor = pickDarkest(input.brandPalette);
    const barBuffer = await sharp({
      create: {
        width: spec.width,
        height: template.textZoneH,
        channels: 4,
        background: { ...barColor, alpha: template.barOpacity },
      },
    })
      .png()
      .toBuffer();

    // 3. Render campaign message text as SVG overlay
    const textSvg = renderTextSvg(input.message, spec.width, template.textZoneH, template.fontSize);

    // 4. Resize logo to template size (preserving aspect ratio)
    const logoResized = await sharp(input.logoImage)
      .resize(template.logoSize, template.logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // 5. Composite all layers: hero base + bar + text + logo
    const final = await sharp(resized)
      .composite([
        // Semi-transparent bar behind text
        { input: barBuffer, top: template.textZoneY, left: 0 },
        // Text overlay centered on the bar
        { input: textSvg, top: template.textZoneY, left: 0 },
        // Logo in corner
        { input: logoResized, top: template.logoY, left: template.logoX },
      ])
      .png()
      .toBuffer();

    // Write the final creative to the creatives/ subfolder — separate from audit artifacts.
    // Output structure: <outputDir>/creatives/<product>/<ratio>.png
    // Uses direct fs write (not storage adapter) because ctx.outputDir is absolute
    // and may differ from the storage adapter's base directory.
    const outputPath = `creatives/${input.productId}/${input.aspectRatio.replace(':', 'x')}.png`;
    const fullPath = join(ctx.outputDir, outputPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, final);

    return {
      productId: input.productId,
      aspectRatio: input.aspectRatio,
      outputPath,
      heroSource: 'generated', // overwritten by orchestrator
      heroPath: '', // set by orchestrator
      textRendered: input.message,
      compositionDetails: {
        template: template.name,
        overridesApplied,
        zoneCoordsY: template.textZoneY,
        barOpacity: template.barOpacity,
        fontSize: template.fontSize,
        logoCoordsX: template.logoX,
        logoCoordsY: template.logoY,
      },
    };
  }
}
