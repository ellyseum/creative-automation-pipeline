# Creative Automation Pipeline

[![CI](https://github.com/ellyseum/creative-automation-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/ellyseum/creative-automation-pipeline/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![ESM](https://img.shields.io/badge/module-ESM-f7df1e?logo=javascript&logoColor=black)](https://nodejs.org/api/esm.html)
[![Tested with Vitest](https://img.shields.io/badge/tested_with-vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](#license)

AI-powered CLI tool that generates social ad creatives from a campaign brief. Takes a YAML brief with brand guidelines, products, and campaign message — produces composited ad creatives across multiple aspect ratios with brand compliance and legal checks built in.

## PoC Scope

This is a time-boxed proof of concept. The primary deliverable is the CLI pipeline:

- Accepts a YAML campaign brief with 2+ products
- Reuses existing assets when provided (`hero_asset`)
- Generates missing hero assets via the configured image provider
- Produces 1:1, 9:16, and 16:9 creatives with campaign message overlay
- Writes organized outputs by product and aspect ratio
- Produces a manifest, executive report, and agent audit log

The web UI, Azurite integration, CI, Playwright tests, and provider adapters are included as **demo accelerators and integration signals**, not production-complete services. 

Once the core CLI assignment was complete, the remaining timebox was used for bonus polish and demoability.

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure (copy and fill in your Gemini API key)
cp .env.example .env
# Edit .env: set GEMINI_API_KEY

# 3. Run
bin/pipeline run briefs/example.yaml  # or example-ja.yaml
```

Output lands in `output/run-<timestamp>/` with organized product folders, a manifest, and an executive report.

### No API key? Run in stub mode:
```bash
IMAGE_PROVIDER=stub bin/pipeline run briefs/example.yaml
```
Produces placeholder images — useful for reviewing pipeline structure without burning API credits.

## Implementation Status

| Area | Status | Notes |
|------|--------|-------|
| CLI pipeline | **Complete** | Main assignment path. Runs locally with real or stub providers. |
| YAML brief parsing | **Complete** | Validated with zod. |
| Asset reuse | **Complete** | Explicit `hero_asset` override is respected; RAG library search supports reuse/hybrid/generate strategy. |
| Missing asset generation | **Complete** | Imagen adapter implemented; stub generation path covered by automated tests. |
| Aspect-ratio output | **Complete** | 1:1, 9:16, and 16:9 PNGs with platform-aware safe zones. |
| Message overlay | **Complete** | Fixed templates with SVG text rendering. |
| Brand checks | **Basic PoC** | Palette dominance (deterministic) plus multimodal LLM review. Not a full brand-governance engine. |
| Legal checks | **Basic PoC** | Static prohibited-word scan plus multimodal LLM review. Not a substitute for legal approval. |
| Audit log | **Complete** | Per-invocation inputs/outputs/status/duration/cost. LLM cost estimated from token counts per agent call. |
| Cost tracking | **Complete** | Image generation + LLM inference costs tracked per agent, per product, per provider. |
| Web UI | **Demo layer** | Simple local UI for running and viewing outputs. Not production-hardened. |
| Azure Blob | **Integration demo** | Adapter implemented and Azurite-tested. Final deliverables written to local filesystem for review simplicity. |
| Firefly | **Integration-ready** | Real `@adobe/firefly-apis` SDK code exists. Requires enterprise IMS credentials — not exercised in CI. |
| Localization | **Working** | ja-JP sample brief included; real LLM path supports localization. Stub mode returns English for all regions. |

## What It Does

```
Campaign Brief (YAML)
  |
  v
[Asset Analyzer]         -- multimodal LLM describes each library asset
[Creative Director]      -- LLM with tool calling searches library, plans strategy
                            (coerces declared brief assets into hybrid strategy)
[Prompt Engineer]        -- crafts diffusion-optimized prompts; flips guidance to
                            "preserve subject" when a declared reference is present
[Hero Generator]         -- Nano Banana Pro (gemini-3-pro-image-preview) — supports
                            reference-image input for image-to-image subject preservation
[Brand Auditor]          -- hybrid: color histogram + multimodal LLM compliance check
[Subject Preservation]   -- vision LLM compares generated hero vs. declared reference,
                            scores similarity, feeds issues+suggestions into retry loop
[Localizer]              -- cultural message adaptation per region
[Composer]               -- sharp: resize + text overlay + logo + brand bar
[Legal Reviewer]         -- hybrid: regex blocklist + multimodal legal scan
                            (flags include rationale citing the specific rule)
[Report Writer]          -- LLM generates executive markdown summary
  |
  v
6 composited creatives + manifest.json + report.md + audit.jsonl
```

## Architecture

Clean Architecture (hexagonal). See [DESIGN.md](DESIGN.md) for full details.

```
src/
  domain/      -- pure types + zod schemas (no external deps)
  ports/       -- interfaces (LLMClient, ImageGenerator, Storage, AssetIndex)
                  ImageGenerator supports optional referenceImages for image-to-image
  agents/      -- 10 focused AI workers, each with a single job
                  (incl. subject-preservation for image-to-image verification)
  use-cases/   -- pipeline orchestrator with ReAct retry loops
                  (brand auditor + subject preservation run in parallel;
                   feedback from both merges into a single retry prompt)
  adapters/    -- concrete implementations:
                  - gemini-llm (text/vision/embedding) with sticky model fallback
                  - gemini-image (Nano Banana Pro + Flash) with sticky model fallback
                  - imagen, firefly, azure blob, local fs, stubs
  infra/       -- logger, audit writer, cost tracker, run context, retry
  cli.ts       -- commander entry point
  server.ts    -- Express web server (demo layer, exits cleanly on EADDRINUSE)
```

Dependencies flow inward only. Image generation and storage providers are selected via env vars; LLM/model selection is Gemini-based in this PoC.

## Campaign Brief Format

```yaml
brand:
  id: morning-co
  name: Morning Co.
  logo: assets/brands/morning-co/logo.png
  palette: ["#FF5733", "#1A1A1A", "#F5F5F0"]
  tone: "energetic, minimal, health-forward"

campaign:
  name: "Summer Launch 2026"
  message: "Level Up Your Morning"

region: en-US
audience: "millennials, urban, health-conscious"

products:
  - id: solar-flask
    name: Solar Flask 1L
    description: Premium copper-lined insulated water bottle
    hero_asset: assets/products/solar-flask/hero.jpg  # reused

  - id: dawn-brew
    name: Dawn Brew Tea
    description: Organic morning tea blend
    # no hero_asset -- generated via GenAI
```

## Output Structure

```
output/run-2026-04-16T23-16-47/
  manifest.json              -- structured audit: products, costs, checks
  report.md                  -- LLM-generated executive summary
  audit.jsonl                -- per-agent invocation log (append-only)
  _audit/                    -- per-invocation input/output artifacts
  creatives/                 -- deliverable assets (separate from audit)
    _intermediate/           -- generated hero images (pre-composition)
    solar-flask/
      1x1.png                -- Instagram/Facebook Feed (1080x1080)
      9x16.png               -- Stories/Reels/TikTok (1080x1920)
      16x9.png               -- YouTube/Display (1920x1080)
    dawn-brew/
      1x1.png
      9x16.png
      16x9.png
```

## CLI Reference

```bash
# Run the full pipeline (via bin script — auto-sources .env)
bin/pipeline run briefs/example.yaml

# Or directly via npx
npx tsx src/cli.ts run <brief.yaml>

# Inspect past run audit trail
bin/pipeline audit output/run-<id>

# Cost breakdown
bin/pipeline cost output/run-<id>
```

## Web Server (Demo Layer)

```bash
# Start the web server (auto-sources .env)
bin/server
# Or: npm run dev

# Open http://localhost:3000
# Select a brief, click "Run Pipeline", watch results appear
```

API endpoints:
- `POST /api/run` — start a pipeline run (returns job ID)
- `GET /api/jobs/:id` — poll job status
- `GET /api/runs` — list past runs
- `GET /api/runs/:id` — get run manifest
- `GET /api/runs/:id/creatives` — list creative files
- `GET /api/runs/:id/audit` — get audit log entries
- `GET /api/runs/:id/report` — get markdown report

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | (required) | Google AI API key |
| `IMAGE_PROVIDER` | `imagen` | `imagen` / `firefly` / `stub` |
| `LLM_MODEL` | `gemini-3.1-pro-preview` | Override LLM model |
| `STORAGE_BACKEND` | `local` | `local` / `azure` |
| `AZURE_STORAGE_CONNECTION_STRING` | -- | For Azure Blob (Azurite or real) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Provider Adapters

| Provider | Status | Use Case |
|----------|--------|----------|
| **Google Gemini 3.1 Pro** | Default | LLM + multimodal vision + embeddings |
| **Google Imagen 4 Fast** | Default | Image generation ($0.02/image) |
| **Adobe Firefly Services** | Integration-ready | Production target for Adobe customers (requires enterprise IMS) |
| **Azure Blob Storage** | Integration demo | Adapter tested via Azurite; pipeline outputs to local FS for simplicity |
| **Local Filesystem** | Default | Zero-config development storage |

## Docker (Azurite for Azure Blob)

```bash
docker-compose up -d        # starts Azurite
# Set in .env:
STORAGE_BACKEND=azure
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;
```

## Testing

```bash
npm test                    # unit + CLI E2E (29 tests)
npm run test:api            # API E2E — Express server lifecycle (6 tests)
npm run test:playwright     # Frontend E2E — Playwright browser tests (4 tests)
npm run test:all            # everything sequentially
npm run test:unit           # unit only (no API calls)
npm run test:watch          # watch mode
```

### Test Results Matrix

46 tests across 5 tiers. CI runs on Node 20 + 22 via GitHub Actions.

| Tier | Tests | Status | What | Dependencies |
|------|-------|--------|------|-------------|
| **Unit** | 28 | Pass | Brief schema validation, cost tracker accumulation/groupBy, asset index cosine similarity + ranking, FS storage CRUD, audit writer JSONL + artifacts | None |
| **CLI E2E** | 1 | Pass | Full pipeline stub run: 6 PNGs + manifest + report + audit.jsonl verified in temp dir | None |
| **API E2E** | 6 | Pass | Express server lifecycle: POST /api/run → poll job → completed, all data endpoints, static serving, frontend HTML | Auto-starts server (random port) |
| **Azurite** | 7 | Pass | Azure Blob Storage: put/get text, put/get binary PNG, exists, list prefix, delete, URL response | docker-compose up (skipped if unavailable) |
| **Playwright** | 4 | Pass | Browser UI: page load, brief dropdown populated, run pipeline → 6 creative cards with badges, past runs navigation | Auto-starts server + Chromium |

### Pre-commit / Pre-push Hooks

Husky enforces code quality on every commit:
- **Pre-commit**: lint-staged runs Prettier + ESLint on changed `.ts` files
- **Pre-push**: `npm test` runs unit + CLI E2E (29 tests, ~3s)

## Key Design Decisions

1. **Clean Architecture** -- domain depends on nothing, adapters are outer ring
2. **Gemini for all AI roles** -- one API key covers LLM + vision + embeddings + image gen
3. **Adobe Firefly adapter shipped but gated** -- real SDK code, requires enterprise creds
4. **RAG via analyzed descriptions** -- Asset Analyzer describes images, embeds text (not pixels) for inspectable retrieval
5. **Creative Director uses tool calling** -- agentic search over asset library during planning (two-phase: tools then structured output, split into tool-calling then structured output for reliability in this PoC)
6. **ReAct retry loops** -- Brand Auditor feedback feeds back to Prompt Engineer for hero generation (max 2 retries). Composition brand checks are advisory-only (the composer is deterministic and cannot act on art direction feedback)
7. **JSONL audit trail** -- every agent invocation logged with input/output artifact refs
8. **Platform safe zones** -- 9:16 avoids IG/TikTok UI regions in text placement
9. **No LangChain/AutoGen** -- hand-written orchestration for full control and line-by-line defensibility

## Known Limitations

- Campaign brief is trusted input (no adversarial prompt injection defense, no HTML sanitization in frontend rendering)
- Free-tier Gemini has rate limits (2-5 RPM) -- pipeline runs sequentially, not parallel
- Brand/legal compliance checks are basic PoC implementations, not production compliance engines
- Localization is LLM-driven (no human-in-the-loop verification)
- Text rendering uses fixed SVG templates (no wrapping, dynamic sizing, or custom brand font rendering)
- Creative Director's `compositionNotes` are produced but not yet wired into Composer behavior
- LLM cost estimates are based on approximate per-token pricing, not actual billing data from the provider
- Stub mode returns canned responses for the sample brief products (not general-purpose for arbitrary briefs)
- In-memory job queue (not persistent across server restarts)
- Azure Blob adapter is tested but final outputs still route through local filesystem writes

## Development Notes

Built as a time-boxed PoC. The core CLI assignment was completed first (~2h10m), satisfying the minimum requirements and covering the listed nice-to-haves at PoC depth. The remaining timebox was used for cleanup, polish, bug fixes and demo accelerators: web UI, API wrapper, integration tests, Playwright coverage, CI, and README polish. 

The git commit window from initial scaffold to final polish is just under 3 hours.

Architecture and design planning was done before the first commit to keep the implementation focused.

## Scaling Notes

| Demo | Production |
|------|------------|
| Local filesystem | Azure Blob / S3 with CDN |
| In-memory cosine search | Azure AI Search / pgvector |
| JSONL audit on disk | Stream to Snowflake/BigQuery |
| Sequential execution | Queue-based parallel per product |
| Manual CLI invocation | Cron + webhooks + event triggers |
| Single machine | Kubernetes / Azure Container Apps |

## Production Hardening Roadmap

### Direct PoC Hardening

- **Plan validation** -- Cross-check the Creative Director plan against the brief so every product is covered exactly once and strategy-specific fields are present.
- **Text layout** -- Add wrapping, dynamic font sizing, CJK-aware layout, and custom brand font rendering via @napi-rs/canvas.
- **Composition notes** -- Wire Creative Director placement guidance into the Composer instead of using only fixed templates.
- **Provider contract tests** -- Add opt-in tests for Gemini, Imagen, Firefly, and Azure paths when credentials are present.
- **Coverage reports** -- Add Istanbul/c8 coverage gates and target untested branches such as retry loops and provider failures.

### Production Scale

- **Multi-region briefs** -- Support `regions: [en-US, ja-JP, es-MX]`, fan out per region, share hero generation, and localize only the message.
- **Persistent job queue** -- Replace the in-memory job map with Redis or Azure Queue for restart safety and horizontal scaling.
- **Content-addressed asset cache** -- Cache generated heroes by `sha256(prompt + brand_guide_version)` to reduce repeated GenAI spend.
- **Per-run cost budgets** -- Add `budget: { max_usd: 1.00 }` to briefs and abort before runaway generation loops exceed budget.
- **A/B creative variants** -- Generate multiple hero candidates, score them, and record selection rationale in the manifest.
- **OpenTelemetry tracing** -- Wrap `RunContext.invoke()` in spans and export traces to Jaeger or Datadog.
- **Webhook triggers** -- Trigger runs from DAM or blob-storage uploads.
- **Production frontend** -- Replace the simple HTML UI with React + Tailwind + shadcn/ui, YAML validation, asset upload, and live progress via SSE.
- **Blue/green deployments** -- Add Dockerfile, deploy to Azure Container Apps or ECS with health check endpoint and zero-downtime rollout.
