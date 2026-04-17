# Creative Automation Pipeline

AI-powered CLI tool that generates social ad creatives from a campaign brief. Takes a YAML brief with brand guidelines, products, and campaign message — produces composited ad creatives across multiple aspect ratios with brand compliance and legal checks built in.

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure (copy and fill in your Gemini API key)
cp .env.example .env
# Edit .env: set GEMINI_API_KEY

# 3. Run
npx tsx src/cli.ts run briefs/example.yaml
```

Output lands in `output/run-<timestamp>/` with organized product folders, a manifest, and an executive report.

### No API key? Run in stub mode:
```bash
IMAGE_PROVIDER=stub npx tsx src/cli.ts run briefs/example.yaml
```
Produces placeholder images — useful for reviewing pipeline structure without burning API credits.

## What It Does

```
Campaign Brief (YAML)
  |
  v
[Asset Analyzer]      -- multimodal LLM describes each library asset
[Creative Director]   -- LLM with tool calling searches library, plans strategy
[Prompt Engineer]     -- crafts diffusion-optimized prompts per product
[Hero Generator]      -- Imagen 4 generates hero images
[Brand Auditor]       -- hybrid: color histogram + multimodal LLM compliance check
[Localizer]           -- cultural message adaptation per region
[Composer]            -- sharp: resize + text overlay + logo + brand bar
[Legal Reviewer]      -- hybrid: regex blocklist + multimodal legal scan
[Report Writer]       -- LLM generates executive markdown summary
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
  agents/      -- 9 focused AI workers, each with a single job
  use-cases/   -- pipeline orchestrator with ReAct retry loops
  adapters/    -- concrete implementations (Gemini, Imagen, Firefly, Azure, stubs)
  infra/       -- logger, audit writer, cost tracker, run context
  cli.ts       -- commander entry point
```

Dependencies flow inward only. Swap providers via env vars — no code changes.

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

## Web Server

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
| `AUDIT` | -- | Set to `1` for verbose artifact logging |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Provider Adapters

| Provider | Status | Use Case |
|----------|--------|----------|
| **Google Gemini 3.1 Pro** | Default | LLM + multimodal vision + embeddings |
| **Google Imagen 4 Fast** | Default | Image generation ($0.02/image) |
| **Adobe Firefly Services** | Stubbed | Production target (requires enterprise IMS) |
| **Azure Blob Storage** | Implemented | Works with Azurite (local) or real Azure |
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
npm run test:all            # everything sequentially (39+ tests)
npm run test:unit           # unit only (no API calls)
npm run test:watch          # watch mode
```

Test tiers:
| Tier | Count | What | Dependencies |
|------|-------|------|-------------|
| Unit | 28 | Brief schema, cost tracker, asset index, FS storage, audit writer | None |
| CLI E2E | 1 | Full pipeline stub run, output structure verification | None |
| API E2E | 6 | Express server job lifecycle, all endpoints | Starts/stops server |
| Azurite | 7 | Azure Blob Storage CRUD | docker-compose up |
| Playwright | 4 | Frontend UI: brief select, run, results grid, past runs | Starts/stops server + browser |

## Key Design Decisions

1. **Clean Architecture** -- domain depends on nothing, adapters are outer ring
2. **Gemini for all AI roles** -- one API key covers LLM + vision + embeddings + image gen
3. **Adobe Firefly adapter shipped but gated** -- real SDK code, requires enterprise creds
4. **RAG via analyzed descriptions** -- Asset Analyzer describes images, embeds text, not pixels
5. **Creative Director uses tool calling** -- agentic search over asset library during planning
6. **ReAct retry loops** -- Brand Auditor feedback feeds back to Prompt Engineer (max 2 retries)
7. **JSONL audit trail** -- every agent invocation logged with input/output artifact refs
8. **Platform safe zones** -- 9:16 avoids IG/TikTok UI regions in text placement
9. **No LangChain/AutoGen** -- hand-written orchestration for full control

## Assumptions & Limitations

- Campaign brief is trusted input (no adversarial prompt injection defense, no HTML sanitization in frontend rendering)
- Free-tier Gemini has rate limits (2-5 RPM) -- pipeline runs sequentially, not parallel
- Brand compliance checks are advisory, not blocking (except on hero generation)
- Localization is LLM-driven (no human-in-the-loop verification)
- Text rendering uses SVG via sharp (system fonts only -- custom brand fonts need @napi-rs/canvas)
- In-memory job queue (not persistent across server restarts -- production would use Redis/SQS)

## Scaling Notes

| Demo | Production |
|------|------------|
| Local filesystem | Azure Blob / S3 with CDN |
| In-memory cosine search | Azure AI Search / pgvector |
| JSONL audit on disk | Stream to Snowflake/BigQuery |
| Sequential execution | Queue-based parallel per product |
| Manual CLI invocation | Cron + webhooks + event triggers |
| Single machine | Kubernetes / Azure Container Apps |
