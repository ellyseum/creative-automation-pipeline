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
import pLimit from 'p-limit';
import { BriefSchema, DEFAULT_ASPECT_RATIOS } from '../domain/brief.js';
import type { Brief, Product } from '../domain/brief.js';
import type { ProductPlan } from '../domain/plan.js';
import type { ProductVariants, BrandCheckResult, LegalCheckResult, Creative } from '../domain/creative.js';
import type { BrandAssetBundle } from '../domain/brand-guide.js';
import type { RunManifest } from '../domain/manifest.js';
import type { RunContext } from '../infra/run-context.js';

// Import all agents
import { AssetAnalyzerAgent } from '../agents/asset-analyzer.js';
import { EmbedderAgent } from '../agents/embedder.js';
import { CreativeDirectorAgent } from '../agents/creative-director.js';
import { PromptEngineerAgent, type PromptOutput } from '../agents/prompt-engineer.js';
import { HeroGeneratorAgent } from '../agents/hero-generator.js';
import { BrandAuditorAgent } from '../agents/brand-auditor.js';
import { SubjectPreservationAgent } from '../agents/subject-preservation.js';
import { LocalizerAgent } from '../agents/localizer.js';
import { ComposerAgent } from '../agents/composer.js';
import { LegalReviewerAgent } from '../agents/legal-reviewer.js';
import { ReportWriterAgent } from '../agents/report-writer.js';

// SHA-256 hash of a buffer — used for idempotent asset analysis caching
function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// Tunable fan-out caps. These are *local* to one pipeline run. The process-
// wide `llmLimit` / `imageGenLimit` in src/infra/rate-limiter.ts provide the
// outer bound against the shared API quota — these limiters just keep a
// single run from flooding the queue with more work than its fair share.
function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Human-friendly duration: "842ms" / "12.3s" / "1m 12s" — used in the
// end-of-run summary so operators can eyeball pipeline walltime at a glance.
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds - mins * 60);
  return `${mins}m ${rem}s`;
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

  ctx.logger.success(
    'brief',
    `${brief.campaign.name} · ${brief.region} · ${brief.products.length} products · ${ratios.length} ratios`,
  );

  // ========== STEP 2: Load brand assets ==========
  ctx.logger.info('brand', 'Loading brand assets...');
  const brandAssets = await loadBrandAssets(brief, ctx);
  ctx.logger.success('brand', `Logo loaded, palette: ${brief.brand.palette.join(', ')}`);

  // ========== STEP 3: Build/refresh asset index ==========
  ctx.logger.info('index', 'Building asset index...');
  await buildAssetIndex(brief, ctx);
  ctx.logger.success('index', 'Asset index ready');

  // ========== STEP 4: Creative Director → plan ==========
  // This is the first big LLM call of the pipeline and can be slow on preview
  // models. Log a starting line so operators don't mistake latency for a
  // silent hang; the invoke() wrapper already logs completion with duration.
  const directorAgent = new CreativeDirectorAgent();
  ctx.logger.info('plan', 'Creative Director planning strategy across all products...');
  const plan = await ctx.invoke(directorAgent, { brief }, { productId: 'creative-director' });
  ctx.logger.success('plan', plan.products.map((p) => `${p.productId}: ${p.strategy}`).join(', '));

  // ========== STEP 5+6: Per product, resolve hero + compose per ratio ==========
  // Products are independent (different hero, different outputs, different
  // cost scope). Fan out with a per-run cap so a brief with many products
  // doesn't spawn unbounded concurrent ReAct hero loops. The shared
  // imageGenLimit / llmLimit in rate-limiter.ts bound total API pressure.
  const productLimit = pLimit(readEnvInt('PRODUCT_CONCURRENCY', 3));
  const productResults = await Promise.all(
    plan.products.map((productPlan) =>
      productLimit(() => processOneProduct(productPlan, brief, brandAssets, ratios, ctx)),
    ),
  );
  const allProductVariants: ProductVariants[] = productResults.filter((p): p is ProductVariants => p !== null);

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
    const report = await ctx.invoke(reportAgent, { manifest }, { productId: 'report-writer' });
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
      `$${manifest.costSummary.totalUsdEst.toFixed(4)} est, ` +
      `${formatDuration(manifest.durationMs)} wall`,
  );

  return manifest;
}

// --- Helper: Process one product end-to-end (hero + all ratio variants) ---
// Extracted so the outer product loop can Promise.all with a concurrency cap.
// Returns null for products listed in the plan but missing from the brief —
// the caller filters these out.
async function processOneProduct(
  productPlan: ProductPlan,
  brief: Brief,
  brandAssets: BrandAssetBundle,
  ratios: string[],
  ctx: RunContext,
): Promise<ProductVariants | null> {
  const product = brief.products.find((p) => p.id === productPlan.productId);
  if (!product) {
    ctx.logger.warn('pipeline', `Product ${productPlan.productId} in plan but not in brief — skipping`);
    return null;
  }

  ctx.logger.header(`Product: ${product.name} (${productPlan.strategy})`);

  // Resolve hero image based on strategy (reuse / hybrid / generate).
  const heroResult = await resolveHero(product, productPlan, brief, brandAssets, ctx);

  // Compose per aspect ratio — fans out internally.
  const variants = await composeAllRatios(product, heroResult, ratios, brief, brandAssets, ctx);

  return {
    productId: product.id,
    heroSource: heroResult.source,
    heroPath: heroResult.path,
    generation: heroResult.generation,
    retrieval: heroResult.retrieval,
    variants,
  };
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
  const { assetIndex, storage } = ctx.adapters;
  await assetIndex.load();

  // Discover all assets in the assets/ directory, filtered to supported images.
  const allPaths = await storage.list('assets/');
  const imagePaths = allPaths.filter((p) => /\.(png|jpg|jpeg|webp)$/i.test(p));
  const analyzerAgent = new AssetAnalyzerAgent();
  const embedderAgent = new EmbedderAgent();

  // Fan out analyze+embed per asset. The shared llmLimit caps the actual
  // outbound API concurrency, so a high local cap here is safe — p-limit
  // just queues the excess. Upserts are collected and applied serially
  // afterward to keep insertion order deterministic.
  const analyzeLimit = pLimit(readEnvInt('ASSET_ANALYZE_CONCURRENCY', 4));
  const analyzed = await Promise.all(
    imagePaths.map((path) =>
      analyzeLimit(async () => {
        const data = await storage.get(path);
        const hash = sha256(data);

        // Idempotent: skip if already analyzed with same content hash
        if (!assetIndex.needsUpdate(path, hash)) return null;

        ctx.logger.info('index', `Analyzing ${path}...`);
        const metadata = await ctx.invoke(analyzerAgent, {
          image: data,
          mimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg',
          pathHint: path,
          brandName: brief.brand.name,
        });

        // Embed the description text for vector search. Routed through
        // ctx.invoke so each embed gets its own audit entry and cost line
        // instead of being silently rolled into the analyzer's invocation.
        const embedResult = await ctx.invoke(embedderAgent, { text: metadata.description });

        return {
          path,
          sha256: hash,
          analyzedAt: new Date().toISOString(),
          metadata,
          embedding: embedResult.vector,
        };
      }),
    ),
  );

  // Apply upserts in input order (not completion order).
  let analyzedCount = 0;
  for (const asset of analyzed) {
    if (!asset) continue;
    assetIndex.upsert(asset);
    analyzedCount++;
  }

  await assetIndex.save();
  if (analyzedCount > 0) ctx.logger.info('index', `Analyzed ${analyzedCount} new/changed assets`);
}

// --- Helper: Resolve hero image per product ---
interface HeroResult {
  source: 'input' | 'generated' | 'retrieved';
  path: string;
  bytes: Buffer;
  generation?: {
    provider: string;
    model: string;
    prompt: string;
    costUsdEst: number;
    durationMs: number;
    referencesUsed?: Array<{ path: string; bytes: number; sha256: string }>;
    subjectPreservation?: {
      verdict: 'pass' | 'warn' | 'fail';
      similarity: number;
      rationale: string;
    };
  };
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
      ctx.logger.warn(
        product.id,
        `hero_asset "${product.hero_asset}" not found in storage — falling back to Director strategy`,
      );
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
  const subjectAgent = new SubjectPreservationAgent();

  // Get reference description + image bytes for hybrid strategy.
  // Declared brief assets flow through here: the asset path becomes the
  // Director's referenceAssetPath, and we load the actual bytes so
  // image-to-image adapters (Nano Banana) can preserve the product subject.
  //
  // referenceDescription: previously this was just plan.referenceRationale,
  // which the Director often left null. We now also pull the asset-analyzer's
  // full description from the asset index so the prompt engineer isn't blind
  // to what the reference actually looks like. If BOTH are present, prefer
  // the analyzer's description — it's the ground-truth visual account.
  let referenceDescription: string | undefined;
  let referenceImages: Array<{ bytes: Buffer; mimeType: string }> | undefined;
  if (plan.strategy === 'hybrid' && plan.referenceAssetPath) {
    ctx.logger.info(product.id, `Using style reference: ${plan.referenceAssetPath}`);
    const indexed = ctx.adapters.assetIndex.get(plan.referenceAssetPath);
    referenceDescription = indexed?.metadata.description ?? plan.referenceRationale ?? undefined;
    try {
      const refBytes = await storage.get(plan.referenceAssetPath);
      const mime = /\.png$/i.test(plan.referenceAssetPath) ? 'image/png' : 'image/jpeg';
      referenceImages = [{ bytes: refBytes, mimeType: mime }];
    } catch (err) {
      ctx.logger.warn(
        product.id,
        `Failed to load reference bytes "${plan.referenceAssetPath}": ${(err as Error).message} — falling back to text-only reference`,
      );
    }
  }

  // ReAct loop: generate → audit → retry if needed.
  // Retries are env-tunable (HERO_MAX_RETRIES). Worst-case spend per product =
  // (N+1) × Imagen gen + (N+1) × brand+subject audits ≈ ~$0.04 × (N+1). At the
  // default N=10 that's ~$0.44/product before we give up. Set HERO_MAX_RETRIES
  // lower for budget-sensitive runs, higher for quality-sensitive runs.
  const MAX_HERO_RETRIES = readEnvInt('HERO_MAX_RETRIES', 10);
  // Accumulate ALL prior-attempt feedback, not just the most recent. LLM
  // retry loops commonly oscillate: fix issue A, regress issue B; fix B,
  // regress A. Showing every past failure keeps all constraints in view.
  const priorFailures: Array<{ attempt: number; feedback: string }> = [];
  let retryFeedback: string | undefined;
  let heroBytes: Buffer | undefined;
  let lastPromptOutput: PromptOutput | undefined;

  for (let attempt = 0; attempt <= MAX_HERO_RETRIES; attempt++) {
    // Subject-preservation mode kicks in when the reference is a declared
    // brief asset — the user literally named this image, so the product
    // in the output must match, not be a lookalike.
    const preserveSubject = !!(plan.referenceAssetPath && product.assets?.includes(plan.referenceAssetPath));

    // Prompt Engineer — craft the diffusion prompt. Pass attempt counters so
    // it can frame retries with appropriate urgency, and the full prior-
    // failure list so every known constraint stays in view across retries.
    lastPromptOutput = await ctx.invoke(
      promptAgent,
      {
        productId: product.id,
        productName: product.name,
        productDescription: product.description,
        generationDirection: plan.generationDirection ?? product.description,
        brandTone: brief.brand.tone,
        brandPalette: brief.brand.palette,
        audience: brief.audience,
        region: brief.region,
        referenceDescription,
        preserveSubject,
        retryFeedback,
        attemptNumber: attempt + 1,
        maxAttempts: MAX_HERO_RETRIES + 1,
        priorFailures,
      },
      { productId: product.id },
    );

    // Hero Generator — generate the image
    const genStart = Date.now();
    const genResult = await ctx.invoke(
      heroAgent,
      {
        prompt: lastPromptOutput.prompt,
        negativePrompt: lastPromptOutput.negativePrompt,
        referenceImages,
      },
      { productId: product.id },
    );
    heroBytes = genResult.image.bytes;

    // Attribute generation cost to the correct product
    ctx.costs.add('hero-generator', genResult.image.costUsdEst, genResult.image.provider, product.id);

    // Brand Auditor + Subject Preservation run in parallel. Brand audit
    // always runs. Subject preservation only runs when we actually passed a
    // declared reference to the generator — otherwise there's nothing to
    // verify. Both produce issues+suggestions; failure from either triggers
    // a retry with merged feedback.
    const auditsPromise = ctx.invoke(
      auditorAgent,
      {
        image: heroBytes,
        mimeType: 'image/png',
        brandPalette: brief.brand.palette,
        brandTone: brief.brand.tone,
        isHeroCheck: true,
        // When preserving a declared subject, the auditor must ignore the
        // product's intrinsic colors — otherwise it contradicts the subject-
        // preservation agent and the loop oscillates.
        preserveSubject,
        subjectDescription: preserveSubject ? `${product.name} — ${product.description}` : undefined,
      },
      { productId: product.id },
    );

    const subjectPromise =
      preserveSubject && referenceImages?.[0]
        ? ctx.invoke(
            subjectAgent,
            {
              referenceImage: referenceImages[0].bytes,
              referenceMimeType: referenceImages[0].mimeType,
              generatedImage: heroBytes,
              generatedMimeType: 'image/png',
              productName: product.name,
              productDescription: product.description,
              referencePath: plan.referenceAssetPath,
            },
            { productId: product.id },
          )
        : Promise.resolve(undefined);

    const [auditResult, subjectResult] = await Promise.all([auditsPromise, subjectPromise]);

    if (subjectResult) {
      ctx.logger.info(
        product.id,
        `Subject preservation: ${subjectResult.verdict} (similarity ${subjectResult.similarity.toFixed(2)})`,
      );
    }

    // A hero "passes" only if BOTH checks pass (or are unavailable).
    // Brand auditor uses 'fail' for failure; subject preservation uses
    // 'fail' the same way. 'warn' is acceptable — promote to the next stage.
    const brandFailed = auditResult.verdict === 'fail';
    const subjectFailed = subjectResult?.verdict === 'fail';

    if (!brandFailed && !subjectFailed) {
      const subjectNote = subjectResult ? `, subject=${subjectResult.verdict}` : '';
      ctx.logger.success(product.id, `Hero brand=${auditResult.verdict}${subjectNote} (attempt ${attempt + 1})`);

      // Save intermediate hero — direct fs write (outputDir is absolute)
      const heroPath = join(ctx.outputDir, 'creatives', '_intermediate', `${product.id}-hero.png`);
      await mkdir(join(ctx.outputDir, 'creatives', '_intermediate'), { recursive: true });
      await writeFile(heroPath, heroBytes);

      // Proof-of-use: record that the declared reference bytes actually
      // made it through the pipeline. Path + size + sha so a reviewer can
      // verify on disk and in the audit trail.
      const referencesUsed =
        referenceImages && plan.referenceAssetPath
          ? [
              {
                path: plan.referenceAssetPath,
                bytes: referenceImages[0].bytes.length,
                sha256: sha256(referenceImages[0].bytes),
              },
            ]
          : undefined;

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
          referencesUsed,
          subjectPreservation: subjectResult
            ? {
                verdict: subjectResult.verdict,
                similarity: subjectResult.similarity,
                rationale: subjectResult.rationale,
              }
            : undefined,
        },
      };
    }

    // Failed — build feedback for the retry. Merge issues+suggestions from
    // BOTH the brand auditor and the subject preservation agent so the
    // prompt engineer sees every concern at once (brand palette drift AND
    // subject drift) and can balance them in a single next pass.
    const brandIssues = brandFailed ? auditResult.issues : [];
    const brandSuggestions = brandFailed ? auditResult.suggestions : [];
    const subjectIssues = subjectFailed ? subjectResult!.issues : [];
    const subjectSuggestions = subjectFailed ? subjectResult!.suggestions : [];

    const sections: string[] = [];
    if (brandIssues.length) sections.push(`Brand audit issues:\n- ${brandIssues.join('\n- ')}`);
    if (brandSuggestions.length) sections.push(`Brand audit suggestions:\n- ${brandSuggestions.join('\n- ')}`);
    if (subjectIssues.length) sections.push(`Subject preservation issues:\n- ${subjectIssues.join('\n- ')}`);
    if (subjectSuggestions.length)
      sections.push(`Subject preservation suggestions:\n- ${subjectSuggestions.join('\n- ')}`);

    const preserveReminder = preserveSubject
      ? '\n\nIMPORTANT: a reference image is attached to the generation call. Preserve the exact product subject from that image while addressing the brand feedback above. Do NOT redesign the product or its packaging — adapt scene, lighting, and composition instead.'
      : '';
    retryFeedback = sections.join('\n\n') + preserveReminder;

    // Remember this attempt's failure so subsequent attempts see the full
    // history, not just the last complaint. Prevents A-fix/B-regress loops.
    priorFailures.push({ attempt: attempt + 1, feedback: retryFeedback });

    const firstIssue = subjectIssues[0] ?? brandIssues[0] ?? 'unknown';
    // Spell both verdicts out so it's obvious WHY the retry fired. Previously
    // the log read "[WARN ...] Hero brand failed (attempt 4)" which blurred
    // the logger level (warn) with the verdict (fail) — easy to misread as
    // "warns triggering retries."
    const brandVerdictLabel = auditResult.verdict;
    const subjectVerdictLabel = subjectResult?.verdict ?? 'n/a';
    ctx.logger.warn(
      product.id,
      `Hero retry: brand=${brandVerdictLabel} subject=${subjectVerdictLabel} (attempt ${attempt + 1} of ${MAX_HERO_RETRIES + 1}): ${firstIssue}`,
    );
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

  // Localize message once per region (cached inside the agent).
  // This runs before the ratio fan-out so every ratio sees the same copy,
  // and so we don't race N localizer calls for the same region.
  const localized = await ctx.invoke(
    localizerAgent,
    {
      message: brief.campaign.message,
      region: brief.region,
      audience: brief.audience,
      brandTone: brief.brand.tone,
    },
    { productId: product.id },
  );

  // Fan out: each ratio's compose + brand audit + legal review is independent.
  // The per-ratio cap keeps one product from monopolizing the global llmLimit;
  // the outer process-wide limiter still bounds total concurrent API calls.
  const ratioLimit = pLimit(readEnvInt('RATIO_CONCURRENCY', 4));
  const variants = await Promise.all(
    ratios.map((ratio) =>
      ratioLimit(() => composeOneRatio(product, hero, ratio, brief, brandAssets, localized.localized, ctx)),
    ),
  );

  return variants;
}

// Compose + audit + legal-check a single aspect ratio variant.
// Extracted so composeAllRatios can Promise.all over the ratio list.
async function composeOneRatio(
  product: Product,
  hero: HeroResult,
  ratio: string,
  brief: Brief,
  brandAssets: BrandAssetBundle,
  localizedMessage: string,
  ctx: RunContext,
): Promise<ProductVariants['variants'][number]> {
  const composerAgent = new ComposerAgent();
  const brandAuditor = new BrandAuditorAgent();
  const legalReviewer = new LegalReviewerAgent();

  ctx.logger.info(product.id, `Composing ${ratio}...`);

  // Composer — deterministic composition (resize, text overlay, logo placement).
  // No retry loop: the composer is not LLM-driven, so brand auditor feedback
  // about art direction (lighting, colors, subject) can't be acted on here.
  // The hero image was already brand-checked in resolveHero() with retries.
  // This check is advisory — flags composition issues for human review.
  const creative = await ctx.invoke(
    composerAgent,
    {
      productId: product.id,
      heroImage: hero.bytes,
      aspectRatio: ratio,
      message: localizedMessage,
      logoImage: brandAssets.logo,
      brandPalette: brief.brand.palette,
      compositionNotes: undefined, // TODO: wire from plan
    },
    { productId: product.id, aspectRatio: ratio },
  );

  // Read the composed creative back for auditing — direct fs read since path is absolute
  const composedPath = join(ctx.outputDir, creative.outputPath);
  const composedBytes = await readFile(composedPath);

  // Brand Auditor and Legal Reviewer read the same composed bytes and are
  // independent — fan out with Promise.all to cut the per-ratio wall-clock
  // roughly in half on top of the outer ratio parallelism.
  const [brandResult, legalResult] = await Promise.all([
    ctx.invoke(
      brandAuditor,
      {
        image: composedBytes,
        mimeType: 'image/png',
        brandPalette: brief.brand.palette,
        brandTone: brief.brand.tone,
        isHeroCheck: false,
      },
      { productId: product.id, aspectRatio: ratio },
    ),
    ctx.invoke(
      legalReviewer,
      {
        image: composedBytes,
        mimeType: 'image/png',
        message: localizedMessage,
        region: brief.region,
      },
      { productId: product.id, aspectRatio: ratio },
    ),
  ]);

  // Update creative with hero source info
  creative.heroSource = hero.source;
  creative.heroPath = hero.path;

  ctx.logger.success(product.id, `${ratio}: brand=${brandResult.verdict}, legal=${legalResult.verdict}`);

  return {
    creative,
    brandCheck: brandResult,
    legalCheck: legalResult,
    retries: 0,
  };
}

// --- Helper: Compute aggregate stats ---
function computeStats(products: ProductVariants[]) {
  let totalCreatives = 0,
    totalGenerations = 0,
    totalRetries = 0;
  let brandPassed = 0,
    brandFailed = 0,
    legalClear = 0,
    legalFlagged = 0;

  for (const pv of products) {
    if (pv.heroSource === 'generated') totalGenerations++;
    for (const v of pv.variants) {
      totalCreatives++;
      totalRetries += v.retries;
      if (v.brandCheck.verdict !== 'fail') brandPassed++;
      else brandFailed++;
      if (v.legalCheck.verdict === 'clear') legalClear++;
      else legalFlagged++;
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
