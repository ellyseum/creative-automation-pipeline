/**
 * Generate Creatives — the main pipeline use case (state machine).
 *
 * This is THE orchestrator. It takes a campaign brief and produces:
 * - Composited creative assets for every product × aspect ratio
 * - Brand and legal compliance results for each
 * - A run manifest with full cost breakdown
 * - An executive markdown report
 * - An append-only audit log of every agent invocation
 *
 * Flow:
 *  1. Parse + validate brief
 *  2. Load brand assets (logo, fonts from storage)
 *  3. Build/refresh asset index (analyze new/changed assets)
 *  4. Creative Director → per-product strategy (reuse/hybrid/generate)
 *  5. Per product: resolve hero (reuse/generate with Brand Auditor ReAct loop)
 *  6. Per product × ratio: localize → compose → audit (brand + legal)
 *  7. Report Writer → executive summary
 *  8. Write manifest + report + audit log
 *
 * ReAct loops:
 *  - Hero generation: Brand Auditor → feedback → Prompt Engineer retry (max 2)
 *  - Composition: Brand Auditor → feedback → Composer retry (max 1)
 */

import { readFile } from 'node:fs/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { BriefSchema, DEFAULT_ASPECT_RATIOS } from '../domain/brief.js';
import type { Brief, Product } from '../domain/brief.js';
import type { CreativePlan, ProductPlan } from '../domain/plan.js';
import type { ProductVariants, BrandCheckResult, LegalCheckResult, Creative } from '../domain/creative.js';
import type { BrandAssetBundle } from '../domain/brand-guide.js';
import type { RunManifest } from '../domain/manifest.js';
import type { RunContext } from '../infra/run-context.js';

// Import all agents
import { AssetAnalyzerAgent } from '../agents/asset-analyzer.js';
import { CreativeDirectorAgent } from '../agents/creative-director.js';
import { PromptEngineerAgent, type PromptOutput } from '../agents/prompt-engineer.js';
import { HeroGeneratorAgent } from '../agents/hero-generator.js';
import { BrandAuditorAgent } from '../agents/brand-auditor.js';
import { LocalizerAgent } from '../agents/localizer.js';
import { ComposerAgent } from '../agents/composer.js';
import { LegalReviewerAgent } from '../agents/legal-reviewer.js';
import { ReportWriterAgent } from '../agents/report-writer.js';

// SHA-256 hash of a buffer — used for idempotent asset analysis caching
function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Run the full creative generation pipeline.
 *
 * @param briefPath - Path to the campaign brief YAML file
 * @param ctx - RunContext with wired adapters, logger, audit, costs
 * @returns The run manifest with all results
 */
export async function generateCreatives(briefPath: string, ctx: RunContext): Promise<RunManifest> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // ========== STEP 1: Parse + validate brief ==========
  ctx.logger.header(`Pipeline: ${briefPath}`);
  ctx.logger.info('brief', 'Loading and validating...');

  const rawYaml = await readFile(briefPath, 'utf-8');
  const parsed = parseYaml(rawYaml);
  const brief: Brief = BriefSchema.parse(parsed);
  const ratios = brief.aspect_ratios ?? [...DEFAULT_ASPECT_RATIOS];

  ctx.logger.success('brief', `${brief.campaign.name} · ${brief.region} · ${brief.products.length} products · ${ratios.length} ratios`);

  // ========== STEP 2: Load brand assets ==========
  ctx.logger.info('brand', 'Loading brand assets...');
  const brandAssets = await loadBrandAssets(brief, ctx);
  ctx.logger.success('brand', `Logo loaded, palette: ${brief.brand.palette.join(', ')}`);

  // ========== STEP 3: Build/refresh asset index ==========
  ctx.logger.info('index', 'Building asset index...');
  await buildAssetIndex(brief, ctx);
  ctx.logger.success('index', 'Asset index ready');

  // ========== STEP 4: Creative Director → plan ==========
  const directorAgent = new CreativeDirectorAgent();
  const plan = await ctx.invoke(directorAgent, { brief });
  ctx.logger.success('plan', plan.products.map(p => `${p.productId}: ${p.strategy}`).join(', '));

  // ========== STEP 5+6: Per product, resolve hero + compose per ratio ==========
  const allProductVariants: ProductVariants[] = [];

  for (const productPlan of plan.products) {
    const product = brief.products.find(p => p.id === productPlan.productId);
    if (!product) {
      ctx.logger.warn('pipeline', `Product ${productPlan.productId} in plan but not in brief — skipping`);
      continue;
    }

    ctx.logger.header(`Product: ${product.name} (${productPlan.strategy})`);

    // Resolve hero image based on strategy
    const heroResult = await resolveHero(product, productPlan, brief, brandAssets, ctx);

    // Compose per aspect ratio
    const variants = await composeAllRatios(
      product, heroResult, ratios, brief, brandAssets, ctx,
    );

    allProductVariants.push({
      productId: product.id,
      heroSource: heroResult.source,
      heroPath: heroResult.path,
      generation: heroResult.generation,
      retrieval: heroResult.retrieval,
      variants,
    });
  }

  // ========== STEP 7: Build manifest ==========
  const manifest: RunManifest = {
    runId: ctx.runId,
    briefFile: briefPath,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    providers: {
      llm: ctx.adapters.llm.name,
      imageGenerator: ctx.adapters.imageGen.name,
      storage: ctx.adapters.storage.name,
      embedding: ctx.adapters.embedding.name,
    },
    brandAssetsUsed: {
      logo: { path: brief.brand.logo, sha256: sha256(brandAssets.logo) },
      palette: brief.brand.palette,
    },
    products: allProductVariants,
    costSummary: ctx.costs.summary(),
    stats: computeStats(allProductVariants),
  };

  // Write manifest
  // Use ctx.outputDir — set by the CLI from the -o flag.
  // Don't hardcode 'output/' — tests may use a temp directory.
  const outputDir = ctx.outputDir;
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // ========== STEP 8: Report Writer ==========
  const reportAgent = new ReportWriterAgent();
  try {
    const report = await ctx.invoke(reportAgent, { manifest });
    await writeFile(join(outputDir, 'report.md'), report.markdown);
    ctx.logger.success('report', `Written to ${join(outputDir, 'report.md')}`);
  } catch (err) {
    ctx.logger.warn('report', `Report generation failed: ${(err as Error).message} — manifest still written`);
  }

  // ========== Summary ==========
  ctx.logger.summary(
    `Done: ${manifest.stats.totalCreatives} creatives, ` +
    `${manifest.stats.totalGenerations} generated, ` +
    `${manifest.stats.totalRetries} retries, ` +
    `$${manifest.costSummary.totalUsdEst.toFixed(4)} est`
  );

  return manifest;
}

// --- Helper: Load brand assets from storage ---
async function loadBrandAssets(brief: Brief, ctx: RunContext): Promise<BrandAssetBundle> {
  const logo = await ctx.adapters.storage.get(brief.brand.logo);
  let displayFont: Buffer | undefined;
  let displayFontPath: string | undefined;

  if (brief.brand.fonts?.display) {
    try {
      displayFont = await ctx.adapters.storage.get(brief.brand.fonts.display);
      displayFontPath = brief.brand.fonts.display;
    } catch {
      ctx.logger.warn('brand', `Font ${brief.brand.fonts.display} not found — using system default`);
    }
  }

  return {
    logo,
    palette: brief.brand.palette,
    tone: brief.brand.tone,
    fonts: displayFont ? { display: displayFont, displayPath: displayFontPath } : undefined,
  };
}

// --- Helper: Build/refresh asset index ---
async function buildAssetIndex(brief: Brief, ctx: RunContext): Promise<void> {
  const { assetIndex, storage, embedding } = ctx.adapters;
  await assetIndex.load();

  // Discover all assets in the assets/ directory
  const assetPaths = await storage.list('assets/');
  const analyzerAgent = new AssetAnalyzerAgent();

  let analyzed = 0;
  for (const path of assetPaths) {
    // Skip non-image files
    if (!/\.(png|jpg|jpeg|webp)$/i.test(path)) continue;

    const data = await storage.get(path);
    const hash = sha256(data);

    // Idempotent: skip if already analyzed with same content hash
    if (!assetIndex.needsUpdate(path, hash)) continue;

    ctx.logger.info('index', `Analyzing ${path}...`);
    const metadata = await ctx.invoke(analyzerAgent, {
      image: data,
      mimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg',
      pathHint: path,
      brandName: brief.brand.name,
    });

    // Embed the description text for vector search
    const vec = await embedding.embed(metadata.description);

    assetIndex.upsert({
      path,
      sha256: hash,
      analyzedAt: new Date().toISOString(),
      metadata,
      embedding: vec,
    });
    analyzed++;
  }

  await assetIndex.save();
  if (analyzed > 0) ctx.logger.info('index', `Analyzed ${analyzed} new/changed assets`);
}

// --- Helper: Resolve hero image per product ---
interface HeroResult {
  source: 'input' | 'generated' | 'retrieved';
  path: string;
  bytes: Buffer;
  generation?: { provider: string; model: string; prompt: string; costUsdEst: number; durationMs: number };
  retrieval?: { query: string; topMatches: Array<{ path: string; similarity: number }>; decision: string };
}

async function resolveHero(
  product: Product,
  plan: ProductPlan,
  brief: Brief,
  brandAssets: BrandAssetBundle,
  ctx: RunContext,
): Promise<HeroResult> {
  const { storage } = ctx.adapters;

  // FIRST: check if the brief explicitly specifies a hero asset for this product.
  // This is a deterministic override — if the client says "use THIS image", respect it.
  // The Director's RAG-based strategy is only consulted when no explicit asset is given.
  if (product.hero_asset) {
    try {
      const exists = await storage.exists(product.hero_asset);
      if (exists) {
        ctx.logger.info(product.id, `Using explicit hero_asset from brief: ${product.hero_asset}`);
        const bytes = await storage.get(product.hero_asset);
        return {
          source: 'input',
          path: product.hero_asset,
          bytes,
        };
      }
      // Asset declared but doesn't exist in storage — warn and fall through to Director strategy
      ctx.logger.warn(product.id, `hero_asset "${product.hero_asset}" not found in storage — falling back to Director strategy`);
    } catch (err) {
      ctx.logger.warn(product.id, `Failed to load hero_asset "${product.hero_asset}": ${(err as Error).message}`);
    }
  }

  // SECOND: use the Director's RAG-based strategy
  // Strategy: REUSE — use the matched asset directly
  if (plan.strategy === 'reuse' && plan.assetPath) {
    ctx.logger.info(product.id, `Reusing asset: ${plan.assetPath} (sim: ${plan.assetSimilarity?.toFixed(2)})`);
    const bytes = await storage.get(plan.assetPath);
    return {
      source: 'retrieved',
      path: plan.assetPath,
      bytes,
      retrieval: {
        query: plan.rationale,
        topMatches: [{ path: plan.assetPath, similarity: plan.assetSimilarity ?? 0 }],
        decision: 'reuse — high-confidence match',
      },
    };
  }

  // Strategy: HYBRID or GENERATE — need Prompt Engineer + Hero Generator
  const promptAgent = new PromptEngineerAgent();
  const heroAgent = new HeroGeneratorAgent();
  const auditorAgent = new BrandAuditorAgent();

  // Get reference description for hybrid strategy
  let referenceDescription: string | undefined;
  if (plan.strategy === 'hybrid' && plan.referenceAssetPath) {
    ctx.logger.info(product.id, `Using style reference: ${plan.referenceAssetPath}`);
    referenceDescription = plan.referenceRationale;
  }

  // ReAct loop: generate → audit → retry if needed (max 2 retries)
  const MAX_HERO_RETRIES = 2;
  let retryFeedback: string | undefined;
  let heroBytes: Buffer | undefined;
  let lastPromptOutput: PromptOutput | undefined;

  for (let attempt = 0; attempt <= MAX_HERO_RETRIES; attempt++) {
    // Prompt Engineer — craft the diffusion prompt
    lastPromptOutput = await ctx.invoke(promptAgent, {
      productId: product.id,
      productName: product.name,
      productDescription: product.description,
      generationDirection: plan.generationDirection ?? product.description,
      brandTone: brief.brand.tone,
      brandPalette: brief.brand.palette,
      audience: brief.audience,
      region: brief.region,
      referenceDescription,
      retryFeedback,
    }, { productId: product.id });

    // Hero Generator — generate the image
    const genStart = Date.now();
    const genResult = await ctx.invoke(heroAgent, {
      prompt: lastPromptOutput.prompt,
      negativePrompt: lastPromptOutput.negativePrompt,
    }, { productId: product.id });
    heroBytes = genResult.image.bytes;

    // Attribute generation cost to the correct product
    ctx.costs.add('hero-generator', genResult.image.costUsdEst, genResult.image.provider, product.id);

    // Brand Auditor — check the generated hero
    const auditResult = await ctx.invoke(auditorAgent, {
      image: heroBytes,
      mimeType: 'image/png',
      brandPalette: brief.brand.palette,
      brandTone: brief.brand.tone,
      isHeroCheck: true,
    }, { productId: product.id });

    if (auditResult.verdict !== 'fail') {
      ctx.logger.success(product.id, `Hero ${auditResult.verdict} (attempt ${attempt + 1})`);

      // Save intermediate hero — direct fs write (outputDir is absolute)
      const heroPath = join(ctx.outputDir, 'creatives', '_intermediate', `${product.id}-hero.png`);
      await mkdir(join(ctx.outputDir, 'creatives', '_intermediate'), { recursive: true });
      await writeFile(heroPath, heroBytes);

      return {
        source: 'generated',
        path: heroPath,
        bytes: heroBytes,
        generation: {
          provider: genResult.image.provider,
          model: genResult.image.model,
          prompt: lastPromptOutput.prompt,
          costUsdEst: genResult.image.costUsdEst,
          durationMs: Date.now() - genStart,
        },
      };
    }

    // Failed — build feedback for the retry
    retryFeedback = auditResult.suggestions.join('. ');
    ctx.logger.warn(product.id, `Hero audit failed (attempt ${attempt + 1}): ${auditResult.issues[0]}`);
  }

  // Exhausted retries — use the last generated hero anyway, flagged in manifest
  ctx.logger.warn(product.id, 'Hero audit failed after max retries — using last generation');
  const heroPath = join(ctx.outputDir, 'creatives', '_intermediate', `${product.id}-hero.png`);
  await mkdir(join(ctx.outputDir, 'creatives', '_intermediate'), { recursive: true });
  await writeFile(heroPath, heroBytes!);

  return {
    source: 'generated',
    path: heroPath,
    bytes: heroBytes!,
    generation: {
      provider: ctx.adapters.imageGen.name,
      model: 'unknown',
      prompt: lastPromptOutput?.prompt ?? '',
      costUsdEst: 0.02 * (MAX_HERO_RETRIES + 1),
      durationMs: 0,
    },
  };
}

// --- Helper: Compose all aspect ratios for one product ---
async function composeAllRatios(
  product: Product,
  hero: HeroResult,
  ratios: string[],
  brief: Brief,
  brandAssets: BrandAssetBundle,
  ctx: RunContext,
): Promise<ProductVariants['variants']> {
  const localizerAgent = new LocalizerAgent();
  const composerAgent = new ComposerAgent();
  const brandAuditor = new BrandAuditorAgent();
  const legalReviewer = new LegalReviewerAgent();

  // Localize message once per region (cached inside the agent)
  const localized = await ctx.invoke(localizerAgent, {
    message: brief.campaign.message,
    region: brief.region,
    audience: brief.audience,
    brandTone: brief.brand.tone,
  }, { productId: product.id });

  const variants: ProductVariants['variants'] = [];

  for (const ratio of ratios) {
    ctx.logger.info(product.id, `Composing ${ratio}...`);

    // Compose the creative (with potential retry for readability)
    const MAX_COMPOSE_RETRIES = 1;
    let creative: Creative | undefined;
    let brandResult: BrandCheckResult | undefined;
    let legalResult: LegalCheckResult | undefined;
    let retries = 0;
    let retryHint: string | undefined;

    for (let attempt = 0; attempt <= MAX_COMPOSE_RETRIES; attempt++) {
      // Composer — deterministic composition
      creative = await ctx.invoke(composerAgent, {
        productId: product.id,
        heroImage: hero.bytes,
        aspectRatio: ratio,
        message: localized.localized,
        logoImage: brandAssets.logo,
        brandPalette: brief.brand.palette,
        compositionNotes: undefined,  // TODO: wire from plan
        retryHint,
      }, { productId: product.id, aspectRatio: ratio });

      // Read the composed creative back for auditing — direct fs read since path is absolute
      const composedPath = join(ctx.outputDir, creative.outputPath);
      const composedBytes = await readFile(composedPath);

      // Brand Auditor — final creative check
      brandResult = await ctx.invoke(brandAuditor, {
        image: composedBytes,
        mimeType: 'image/png',
        brandPalette: brief.brand.palette,
        brandTone: brief.brand.tone,
        isHeroCheck: false,
      }, { productId: product.id, aspectRatio: ratio });

      // Legal Reviewer
      legalResult = await ctx.invoke(legalReviewer, {
        image: composedBytes,
        mimeType: 'image/png',
        message: localized.localized,
        region: brief.region,
      }, { productId: product.id, aspectRatio: ratio });

      // If brand passes (or we're out of retries), done
      if (brandResult.verdict !== 'fail' || attempt >= MAX_COMPOSE_RETRIES) break;

      retryHint = brandResult.suggestions.join('. ');
      retries++;
      ctx.logger.warn(product.id, `${ratio} brand check failed — retrying composer`);
    }

    // Update creative with hero source info
    creative!.heroSource = hero.source;
    creative!.heroPath = hero.path;

    ctx.logger.success(product.id, `${ratio}: brand=${brandResult!.verdict}, legal=${legalResult!.verdict}`);

    variants.push({
      creative: creative!,
      brandCheck: brandResult!,
      legalCheck: legalResult!,
      retries,
    });
  }

  return variants;
}

// --- Helper: Compute aggregate stats ---
function computeStats(products: ProductVariants[]) {
  let totalCreatives = 0, totalGenerations = 0, totalRetries = 0;
  let brandPassed = 0, brandFailed = 0, legalClear = 0, legalFlagged = 0;

  for (const pv of products) {
    if (pv.heroSource === 'generated') totalGenerations++;
    for (const v of pv.variants) {
      totalCreatives++;
      totalRetries += v.retries;
      if (v.brandCheck.verdict !== 'fail') brandPassed++; else brandFailed++;
      if (v.legalCheck.verdict === 'clear') legalClear++; else legalFlagged++;
    }
  }

  return {
    totalProducts: products.length,
    totalCreatives,
    totalGenerations,
    totalRetries,
    brandChecksPassed: brandPassed,
    brandChecksFailed: brandFailed,
    legalChecksClear: legalClear,
    legalChecksFlagged: legalFlagged,
  };
}
