/**
 * Generate realistic test assets using Imagen 4.
 * Run: source ~/.secrets/gemini.env && export GEMINI_API_KEY && node scripts/generate-assets.mjs
 *
 * Creates ~20 assets across brands, products, and lifestyle categories
 * so the RAG pipeline has real content to search over.
 */

import { GoogleGenAI } from '@google/genai';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'imagen-4.0-fast-generate-001';

const ASSETS = [
  // Product shots — Solar Flask (water bottle)
  { path: 'assets/products/solar-flask/hero.jpg', prompt: 'Premium copper-lined insulated water bottle on a light wooden counter, warm morning sunlight, minimalist kitchen background, product photography, 4k' },
  { path: 'assets/products/solar-flask/lifestyle-01.jpg', prompt: 'Person holding a sleek copper water bottle while hiking on a mountain trail, golden hour lighting, health and fitness lifestyle photography' },
  { path: 'assets/products/solar-flask/lifestyle-02.jpg', prompt: 'Copper water bottle on a yoga mat next to fresh fruit, bright airy studio, wellness lifestyle, commercial photography' },
  { path: 'assets/products/solar-flask/detail.jpg', prompt: 'Close-up of copper water bottle cap and rim showing premium metalwork finish, macro product photography, dark background' },

  // Product shots — Dawn Brew Tea
  { path: 'assets/products/dawn-brew/tea-cup.jpg', prompt: 'Organic morning tea in a minimalist white ceramic cup, steam rising, wooden table, soft diffused morning window light, commercial food photography' },
  { path: 'assets/products/dawn-brew/packaging.jpg', prompt: 'Premium tea packaging box with dried herbs and flowers scattered around it, rustic wooden surface, overhead flat lay, product photography' },
  { path: 'assets/products/dawn-brew/lifestyle-01.jpg', prompt: 'Hands cupping a warm mug of herbal tea, cozy morning scene with soft blanket, warm tones, lifestyle photography' },

  // Lifestyle shots (brand-level, not product-specific)
  { path: 'assets/lifestyle/morning-routine-01.jpg', prompt: 'Person stretching by a sunlit window in the morning, minimalist bedroom, health and wellness lifestyle, warm tones, editorial photography' },
  { path: 'assets/lifestyle/morning-routine-02.jpg', prompt: 'Healthy breakfast spread on a wooden table, fresh juice and granola, morning light streaming in, food lifestyle photography' },
  { path: 'assets/lifestyle/kitchen-minimal.jpg', prompt: 'Clean minimalist modern kitchen with marble countertop, morning light, architectural interior photography, warm neutral tones' },
  { path: 'assets/lifestyle/outdoor-morning.jpg', prompt: 'Person jogging on a coastal path at sunrise, silhouette against golden sky, fitness lifestyle photography' },
  { path: 'assets/lifestyle/desk-wellness.jpg', prompt: 'Clean desk workspace with a plant, water bottle, and notebook, soft natural light, productivity and wellness aesthetic' },
  { path: 'assets/lifestyle/yoga-studio.jpg', prompt: 'Empty bright yoga studio with wooden floors and plants, morning light, peaceful wellness space, architectural photography' },

  // Brand assets
  { path: 'assets/brands/morning-co/hero-banner.jpg', prompt: 'Abstract warm gradient background with soft coral and cream tones, subtle texture, brand banner, minimalist design' },
  { path: 'assets/brands/morning-co/pattern.jpg', prompt: 'Seamless geometric pattern in warm coral and off-white tones, minimalist modern design, tileable texture' },

  // Extra products for variety (tests multi-product search)
  { path: 'assets/products/solar-flask/action.jpg', prompt: 'Copper water bottle being filled from a mountain stream, adventure photography, dynamic action shot, outdoor lifestyle' },
  { path: 'assets/products/dawn-brew/ceremony.jpg', prompt: 'Japanese-style tea ceremony setup with minimalist ceramic cups and teapot, zen aesthetic, calm morning light, overhead view' },
  { path: 'assets/lifestyle/market-fresh.jpg', prompt: 'Fresh produce at an outdoor farmers market, vibrant colors, morning shopping, lifestyle photography' },
  { path: 'assets/lifestyle/sunset-relax.jpg', prompt: 'Person sitting on a dock watching sunset with a warm drink, relaxation, golden hour, lifestyle photography' },
];

async function generateAsset(spec, index) {
  const dir = dirname(join(process.cwd(), spec.path));
  await mkdir(dir, { recursive: true });

  console.log(`[${index + 1}/${ASSETS.length}] Generating ${spec.path}...`);

  try {
    const resp = await ai.models.generateImages({
      model: MODEL,
      prompt: spec.prompt,
      config: { numberOfImages: 1, aspectRatio: '1:1' },
    });

    const bytes = Buffer.from(resp.generatedImages[0].image.imageBytes, 'base64');
    await writeFile(spec.path, bytes);
    console.log(`  ✓ ${spec.path} (${(bytes.length / 1024).toFixed(0)} KB)`);
    return true;
  } catch (err) {
    console.error(`  ✗ ${spec.path}: ${err.message?.slice(0, 100)}`);

    // Rate limit — wait and retry once
    if (err.status === 429 || err.status === 503) {
      console.log('  ... waiting 10s and retrying');
      await new Promise(r => setTimeout(r, 10000));
      try {
        const resp = await ai.models.generateImages({
          model: MODEL,
          prompt: spec.prompt,
          config: { numberOfImages: 1, aspectRatio: '1:1' },
        });
        const bytes = Buffer.from(resp.generatedImages[0].image.imageBytes, 'base64');
        await writeFile(spec.path, bytes);
        console.log(`  ✓ ${spec.path} (retry OK, ${(bytes.length / 1024).toFixed(0)} KB)`);
        return true;
      } catch (retryErr) {
        console.error(`  ✗ ${spec.path}: retry failed: ${retryErr.message?.slice(0, 100)}`);
        return false;
      }
    }
    return false;
  }
}

// Generate sequentially to respect rate limits (2 IPM on free tier)
console.log(`Generating ${ASSETS.length} assets with Imagen 4 Fast...\n`);
let success = 0;
for (let i = 0; i < ASSETS.length; i++) {
  const ok = await generateAsset(ASSETS[i], i);
  if (ok) success++;
  // Rate limit spacing — Imagen free tier is 2 images per minute
  if (i < ASSETS.length - 1) {
    console.log('  ... waiting 35s for rate limit');
    await new Promise(r => setTimeout(r, 35000));
  }
}
console.log(`\nDone: ${success}/${ASSETS.length} assets generated.`);
