# Adobe FDE Take-Home: Creative Automation Pipeline

## Context

Take-home for Adobe Forward Deployed Engineer (Creative Technologist) role. Build a CLI pipeline that generates social ad creatives from a campaign brief using GenAI. Must demonstrate Clean Architecture, multi-agent orchestration, multimodal AI (LLM + diffusion + vision), RAG-based asset retrieval, and full audit trail.

Repo: `~/projects/adobe_fde_takehome/`
Stack: Node 20, TypeScript, ESM
Deliverables: public GitHub repo + 2-3 min demo video

## Testing Strategy

Three tiers, using **vitest** (fast, TS-native, zero-config):

### Unit tests (fast, no API calls, no I/O)
- `domain/*.test.ts` — zod schema validation (valid briefs pass, malformed reject with useful errors)
- `agents/composer.test.ts` — placement algorithm: per-ratio defaults, composition_notes overrides, retry hint adjustments, safe zone math
- `infra/cost-tracker.test.ts` — accumulation, groupBy agent/product/provider
- `infra/audit-writer.test.ts` — JSONL append, artifact path generation
- `adapters/json-asset-index.test.ts` — cosine similarity math, indexing, search ranking

### Integration tests (real adapters, stubbed data)
- `adapters/gemini-llm.test.ts` — real Gemini call with tiny prompt, asserts structured response (skipped if no GEMINI_API_KEY)
- `adapters/local-fs-storage.test.ts` — read/write/exists/list against temp dir
- `agents/creative-director.test.ts` — with stubbed LLMClient that returns canned tool_calls + responses, verify plan shape

### E2E test (full pipeline, real or stubbed)
- `e2e/pipeline.test.ts` — runs `generate-creatives` against sample brief
  - With stubs: all adapters return deterministic canned data → assert output folder structure (6 PNGs, manifest.json, report.md, audit.jsonl)
  - With real APIs (CI or manual): full Gemini/Imagen run → verify outputs are valid images, manifest has cost data, report is coherent

**Test scripts in package.json:**
```json
"test": "vitest run",
"test:unit": "vitest run --dir src",
"test:e2e": "vitest run --dir e2e",
"test:watch": "vitest"
```

**Test file convention:** colocated `*.test.ts` next to source (unit), `e2e/` directory for full-pipeline tests.

## Docs: Single DESIGN.md (not separate ARCHITECTURE.md)

One doc with clear sections. Two separate docs for ~1000 LOC reads as overcompensating. DESIGN.md covers:
1. **Problem** — one paragraph
2. **Architecture** — Clean Architecture layers, dependency diagram, folder mapping
3. **Pipeline flow** — ASCII diagram of agent sequence with data flow
4. **Agent catalog** — table of all agents with role, AI type, input/output
5. **Ports & Adapters** — what ships, what's stubbed, what's production target
6. **Decision log** — numbered decisions with rationale
7. **Testing** — what's tested at each tier and why
8. **Non-goals** — explicit list
9. **Scaling notes** — what changes at 100/day, 10k/day

If it grows beyond 3 pages, split. But start combined.

## Cross-Cutting Policies

### Comments: descriptive, explain-every-line
Interview says "explain every line, even if AI-assisted." We pre-annotate with comments that explain the WHY so the code speaks for itself during the live demo. Not JSDoc ceremony — inline // comments on decisions.

### Testability: Claude-testable at every step
Every step must be runnable and verifiable by Claude via CLI before moving to the next. No "build it all, test at end." Incremental correctness.

### Storage: Azurite-only (mock Azure via Docker)
No real Azure credentials needed. Ship a `docker-compose.yml` with Azurite. The `AzureBlobStorage` adapter works identically against Azurite and real Azure — same SDK, same connection string pattern. Shows Docker knowledge + "works offline" story.

### API keys: use honeybee's Gemini key during dev
Source from `~/.secrets/gemini.env` (vault pattern). Ship `.env.example` for reviewers.

## Implementation Order (15 steps)

### Step 1 — Scaffold + DESIGN.md + git init
Create project skeleton with Clean Architecture folder structure.

**Files to create:**
- `DESIGN.md` — architecture doc (captures everything from our pre-planning)
- `package.json` — node 20, ESM, typescript, scripts (build, start, pipeline)
- `tsconfig.json` — strict, ESM, outDir: dist
- `.gitignore` — node_modules, dist, .env, output/, .embeddings/
- `.env.example` — all env vars commented
- `docker-compose.yml` — Azurite (mock Azure Blob), optional for local dev
- `src/` directory structure (folders only — no empty placeholder files)

**Dependencies:**
```
prod: @google/genai, sharp, @napi-rs/canvas (text rendering — sharp can't do custom fonts reliably),
      commander, zod, zod-to-json-schema (for Gemini structured output), yaml, dotenv, @azure/storage-blob
dev: typescript, @types/node, tsx (for dev runs), vitest
optional: @adobe/firefly-apis, @adobe/firefly-services-common-apis, openai
```

**ESM gotcha:** All `.ts` imports must use `.js` extensions (`import { x } from './brief.js'`). Non-negotiable with `module: "nodenext"`. `tsx` handles this transparently for dev runs.

**Commit:** `docs: DESIGN.md + project scaffold`

### Step 1.1 — .claude/ project config
Set up Claude Code integration so any future session (or interviewer using Claude Code) gets instant project context.

**Files:**
- `.claude/CLAUDE.md` — project-specific instructions:
  - What this project is (Adobe FDE take-home, creative automation pipeline)
  - Architecture: Clean Architecture layers, dependency rule
  - Code conventions: descriptive comments on every decision, ESM with `.js` import extensions
  - Testing: vitest, colocated `*.test.ts`, e2e in `e2e/`
  - Adding adapters: implement the port interface, register in factory.ts
  - Env setup: copy `.env.example` → `.env`, fill in `GEMINI_API_KEY`
  - Docker: `docker-compose up -d` for Azurite
  - Never commit `.env` or API keys
  - Brief schema lives in `src/domain/brief.ts` (zod) — update schema there, not in YAML validation logic
  - Agent prompts: each agent's system prompt is in its own file, inline — don't extract to separate prompt files (keep code + prompt colocated for defensibility)
- `.claude/settings.json` — permissions (allow running tests, build, CLI)

**Commit:** `chore: .claude project config for Claude Code integration`

### Step 2 — Domain layer (entities + schemas)
Pure types, zero external imports.

**Files:**
- `src/domain/brief.ts` — zod schema for campaign brief YAML (brand, campaign, products, region, audience)
- `src/domain/creative.ts` — Creative, Variant, AspectRatio types
- `src/domain/plan.ts` — CreativePlan, ProductStrategy ('reuse'|'hybrid'|'generate')
- `src/domain/invocation.ts` — AgentInvocation envelope type
- `src/domain/brand-guide.ts` — BrandGuide, BrandAssets types
- `src/domain/asset-metadata.ts` — AssetMetadata (from analyzer), AssetMatch (from retriever)

**Commit:** `feat: domain layer — brief schema, creative types, invocation envelope`

### Step 3 — Ports (interfaces)
What the application needs from the outside world.

**Files:**
- `src/ports/llm-client.ts` — `LLMClient { complete(system, messages, schema?) }`, `MultimodalLLMClient { analyzeImage(image, prompt, schema?) }`, `embed(input)`
- `src/ports/image-generator.ts` — `ImageGenerator { generate(prompt, width, height, n?) }`
- `src/ports/storage.ts` — `Storage { exists, get, put, list, delete? }`
- `src/ports/asset-index.ts` — `AssetIndex { index(assets), search(query, k) }`

**Commit:** `feat: port interfaces — LLM, image generator, storage, asset index`

### Step 4 — Infrastructure (cross-cutting)
Logger, audit writer, cost tracker, run context with invoke() wrapper.

**Files:**
- `src/infra/logger.ts` — stdout pretty-print + structured JSON stderr
- `src/infra/audit-writer.ts` — append-only JSONL writer, artifact file writer
- `src/infra/cost-tracker.ts` — accumulates cost by agent/product/provider
- `src/infra/run-context.ts` — `RunContext { invoke(agent, input, scope), logger, audit, costs, storage, runId }`
- `src/infra/env.ts` — dotenv loading + env var helpers (`must()`, `optional()`)

**Commit:** `feat: infra — run context, audit writer, cost tracker, logger`

### Step 5 — Adapters (concrete implementations)
Ship working adapters for Gemini/Imagen + local FS. Stub Firefly + Azure Blob.

**Files:**
- `src/adapters/gemini-llm.ts` — implements LLMClient + MultimodalLLMClient + embed via @google/genai
- `src/adapters/imagen-generator.ts` — implements ImageGenerator via @google/genai (Imagen 4 Fast)
- `src/adapters/local-fs-storage.ts` — implements Storage against local filesystem
- `src/adapters/json-asset-index.ts` — implements AssetIndex with in-memory cosine sim + JSON persistence
- `src/adapters/firefly-generator.ts` — implements ImageGenerator via @adobe/firefly-apis. Uses constructor-based auth (clientId+clientSecret, auto-refresh). **GOTCHA: Firefly returns pre-signed URLs that expire in 1 hour — adapter must fetch+buffer immediately.**
- `src/adapters/azure-blob-storage.ts` — implements Storage via @azure/storage-blob. **Azurite-only for demo** (same SDK, same code, swappable to real Azure via connection string). Docker-compose ships Azurite.
- `src/adapters/openai-llm.ts` — implements LLMClient via openai SDK (fallback)
- `src/adapters/factory.ts` — `resolveAdapters(env)` — reads env vars, returns wired adapter set

**Commit:** `feat: adapters — Gemini, Imagen, local FS, Firefly stub, Azure Blob, factory`

### Step 6 — Agent base + first agents (Asset Analyzer, Creative Director)
Agent<I,O> interface + the two pipeline-driving agents.

**Files:**
- `src/agents/base.ts` — `Agent<I, O> { name, execute(input, ctx) }`
- `src/agents/asset-analyzer.ts` — multimodal LLM → structured AssetMetadata
- `src/agents/creative-director.ts` — LLM with search_assets tool → CreativePlan

**Key: Creative Director uses Asset Retriever as a callable tool during planning.**
The director's LLM call includes a `search_assets` function definition. When the LLM returns a tool_call, the orchestrator executes it (vector search via AssetIndex), returns results, and continues the conversation. Each sub-call is logged as its own invocation with parent_invocation_id.

**Commit:** `feat: agents — asset analyzer + creative director with RAG tool`

### Step 7 — Remaining agents
All other agents in the pipeline.

**Files:**
- `src/agents/prompt-engineer.ts` — concept + product + reference → diffusion prompt
- `src/agents/hero-generator.ts` — thin wrapper around ImageGenerator port
- `src/agents/brand-auditor.ts` — hybrid: deterministic (histogram) + multimodal LLM → BrandReport
- `src/agents/localizer.ts` — LLM cultural adaptation of campaign message
- `src/agents/composer.ts` — @napi-rs/canvas for text rendering (sharp can't do custom fonts reliably), sharp for resize + composite + logo overlay. Per-ratio templates with safe zones. Reads Director's composition_notes for placement hints.
- `src/agents/legal-reviewer.ts` — hybrid: regex blocklist + multimodal LLM → LegalReport
- `src/agents/report-writer.ts` — LLM → markdown executive summary from manifest

**Commit:** `feat: agents — prompt engineer, hero gen, auditor, localizer, composer, legal, reporter`

### Step 8 — Orchestrator (the state machine)
The main use-case: GenerateCreatives.

**File:** `src/use-cases/generate-creatives.ts`

Flow:
1. Parse + validate brief (zod)
2. Load brand assets (logo, fonts, palette from storage)
3. Build/load asset index (.embeddings/index.json — analyze new assets, skip cached)
4. Invoke Creative Director → CreativePlan (per product: reuse/hybrid/generate strategy)
5. Per product:
   a. If reuse → load asset from storage
   b. If hybrid → load reference asset, invoke Prompt Engineer w/ reference, Hero Generator, Brand Auditor (ReAct loop max 2)
   c. If generate → invoke Prompt Engineer, Hero Generator, Brand Auditor (ReAct loop max 2)
6. Per product × per aspect ratio:
   a. Invoke Localizer (cached per region)
   b. Invoke Composer
   c. Invoke Brand Auditor (final pass) + Legal Reviewer
   d. If brand fail → retry Composer once with hint
7. Invoke Report Writer
8. Write manifest.json, report.md, audit.jsonl

**Commit:** `feat: orchestrator — generate-creatives use case with ReAct loops`

### Step 9 — CLI entry point
Commander-based CLI with subcommands.

**Files:**
- `src/cli.ts` — main entry, commander setup
- `src/commands/run.ts` — `pipeline run <brief>` → loads adapters, calls generate-creatives
- `src/commands/agent.ts` — `pipeline agent <name> [args]` → single-agent invocation for debug
- `src/commands/audit.ts` — `pipeline audit <run-dir>` → prints invocation summary
- `src/commands/cost.ts` — `pipeline cost <run-dir>` → cost breakdown table

**package.json scripts:**
```json
"build": "tsc",
"start": "node dist/cli.js",
"pipeline": "tsx src/cli.ts"
```

**Commit:** `feat: CLI — run, agent, audit, cost subcommands`

### Step 10 — Sample brief + sample assets
Ship a working example so reviewers can clone-and-run.

**Files:**
- `briefs/example.yaml` — "Summer Launch 2026", Morning Co. brand, 2 products
- `assets/brands/morning-co/logo.png` — simple placeholder logo (create via sharp or find CC0)
- `assets/products/solar-flask/hero.jpg` — CC0 product photo (or generate one during dev)
- `assets/lifestyle/morning-routine.jpg` — CC0 lifestyle photo

**Commit:** `chore: sample brief + input assets`

### Step 11 — Tests
Write tests at all three tiers. Framework: vitest.

**Files:**
- `src/domain/brief.test.ts` — valid/invalid brief schemas (zod)
- `src/agents/composer.test.ts` — placement logic per ratio, override parsing, safe zones
- `src/infra/cost-tracker.test.ts` — accumulation + groupBy
- `src/infra/audit-writer.test.ts` — JSONL append + artifact refs
- `src/adapters/json-asset-index.test.ts` — cosine sim, index/search
- `src/adapters/local-fs-storage.test.ts` — read/write/exists against tmpdir
- `src/agents/creative-director.test.ts` — stubbed LLM with canned tool_call → verify plan shape
- `e2e/pipeline.test.ts` — full run with stub adapters → verify output structure (6 PNGs, manifest, report, audit)

**Add to package.json:** vitest as dev dep, test scripts:
```json
"test": "vitest run",
"test:unit": "vitest run --dir src",
"test:e2e": "vitest run --dir e2e",
"test:watch": "vitest"
```

**Commit:** `test: unit + integration + e2e tests`

### Step 12 — End-to-end real run + bug fixes
Run the full pipeline against the sample brief with REAL APIs. Fix whatever breaks.

- `npm run build && node dist/cli.js run briefs/example.yaml`
- Verify: 6 output PNGs in organized folders, valid images
- Verify: manifest.json with all fields populated
- Verify: report.md generated and coherent
- Verify: audit.jsonl has all invocations with parent chains
- Verify: `npm test` — all tiers green

**Commit:** `fix: <whatever breaks>`

### Step 14 — README
Comprehensive README with:
- What it does (1 paragraph)
- Architecture overview (pointer to DESIGN.md)
- Quick start (3 commands)
- .env setup for real services vs local mode
- Example input + output (screenshot of terminal, grid of output creatives)
- CLI reference
- Design decisions (short, pointer to DESIGN.md for detail)
- Assumptions + limitations
- Scaling notes

**Commit:** `docs: comprehensive README`

### Step 15 — Demo video (2-3 min)
Record with OBS or similar:
- Show the brief YAML
- Run the pipeline
- Show output folder structure
- Show manifest.json highlights
- Show report.md
- Flash the architecture (DESIGN.md or a diagram)
- Close with "here's what I'd add for a real client"

Not a git commit — separate deliverable.

## Critical Files (full tree)

```
adobe_fde_takehome/
├── .claude/
│   ├── CLAUDE.md
│   └── settings.json
├── DESIGN.md
├── README.md
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example
├── briefs/example.yaml
├── assets/
│   ├── brands/morning-co/logo.png
│   ├── products/solar-flask/hero.jpg
│   └── lifestyle/morning-routine.jpg
├── src/
│   ├── cli.ts
│   ├── commands/
│   │   ├── run.ts
│   │   ├── agent.ts
│   │   ├── audit.ts
│   │   └── cost.ts
│   ├── domain/
│   │   ├── brief.ts
│   │   ├── creative.ts
│   │   ├── plan.ts
│   │   ├── invocation.ts
│   │   ├── brand-guide.ts
│   │   └── asset-metadata.ts
│   ├── use-cases/
│   │   └── generate-creatives.ts
│   ├── agents/
│   │   ├── base.ts
│   │   ├── asset-analyzer.ts
│   │   ├── creative-director.ts
│   │   ├── prompt-engineer.ts
│   │   ├── hero-generator.ts
│   │   ├── brand-auditor.ts
│   │   ├── localizer.ts
│   │   ├── composer.ts
│   │   ├── legal-reviewer.ts
│   │   └── report-writer.ts
│   ├── ports/
│   │   ├── llm-client.ts
│   │   ├── image-generator.ts
│   │   ├── storage.ts
│   │   └── asset-index.ts
│   ├── adapters/
│   │   ├── factory.ts
│   │   ├── gemini-llm.ts
│   │   ├── imagen-generator.ts
│   │   ├── firefly-generator.ts
│   │   ├── openai-llm.ts
│   │   ├── local-fs-storage.ts
│   │   ├── azure-blob-storage.ts
│   │   └── json-asset-index.ts
│   └── infra/
│       ├── run-context.ts
│       ├── audit-writer.ts
│       ├── cost-tracker.ts
│       ├── logger.ts
│       └── env.ts
└── output/  (gitignored)
```

## Verification

After Step 12, confirm:
1. `npm run build` — zero TS errors
2. `npm test` — all unit + integration + e2e tests green
3. `node dist/cli.js run briefs/example.yaml` — completes, produces 6 PNGs
4. `output/run-*/manifest.json` — all products, all variants, cost breakdown
5. `output/run-*/report.md` — readable executive summary
6. `output/run-*/audit.jsonl` — one line per agent invocation, parent chains for retries
7. `node dist/cli.js audit output/run-*` — prints summary
8. `node dist/cli.js cost output/run-*` — prints cost table
9. `IMAGE_PROVIDER=stub node dist/cli.js run briefs/example.yaml` — runs without API keys (local mode with placeholders)

## Key Design Decisions (for DESIGN.md)

1. **Clean Architecture** — domain depends on nothing, use-cases depend on ports only, adapters are outer ring
2. **Gemini for all AI roles** — one API key covers text LLM + multimodal vision + image generation (Imagen 4). Single billing surface.
3. **Adobe Firefly adapter shipped but gated** — real SDK code, requires enterprise IMS creds. Falls back gracefully. Production target, not demo target.
4. **RAG via analyzed descriptions, not raw pixel embeddings** — Asset Analyzer produces inspectable metadata first, then embeds the description. Auditable, debuggable.
5. **Creative Director uses retriever as a tool** — agentic pattern (tool-calling LLM), not linear pipeline. Director queries library during planning.
6. **ReAct retry loops** — Brand Auditor feedback feeds back to Prompt Engineer (max 2 retries for hero) and Composer (max 1 retry for final creative).
7. **Per-agent JSONL audit** — every invocation logged with input/output refs. Artifacts stored separately. Supports replay, cost attribution, compliance.
8. **Platform safe zones in Composer** — 9:16 avoids IG/TikTok UI regions. Production-credible defaults.
9. **Idempotent asset analysis** — sha256-keyed, re-analyze only changed assets.
10. **No LangChain/AutoGen** — hand-written agent loop for full control and line-by-line defensibility.

## Research Findings (grounding)

### @google/genai (v1.50)
- `ai.models.generateImages()` — ✅ exists. Model: `imagen-4.0-fast-generate-001`. Returns base64 bytes, NOT URLs. Supports aspect ratios: 1:1, 3:4, 4:3, 9:16, 16:9. Max 4 images/request.
- `ai.models.embedContent()` — ✅ exists. Model: `gemini-embedding-001` (text only, 3072 dims, truncatable to 768). `gemini-embedding-2-preview` for multimodal (images+text). Use `taskType: "RETRIEVAL_DOCUMENT"` for indexing, `"RETRIEVAL_QUERY"` for search.
- `ai.models.generateContent()` with images — ✅ multimodal vision works. Pass `inlineData: { mimeType, data: base64 }`.
- **Structured output** — ✅ `responseMimeType: "application/json"` + `responseJsonSchema`. Use `zod-to-json-schema`. **Model: `gemini-2.5-flash`** (not preview variants — those 404).
- **Function calling** — ✅ full round-trip. Model: `gemini-2.5-flash`. Define tools via `functionDeclarations`, model returns `functionCalls`, send back `functionResponse` with matching `id`. Uses `Type` enum (not raw strings) for parameter schemas. `mode: "ANY"` forces tool use.

### Verified API validation (2026-04-16, honeybee keys)
All 5 capabilities confirmed working:
- imagen-4.0-fast-generate-001: base64 PNG, ~1.5MB per image ✓
- gemini-embedding-001 @ 768 dims: float array ✓
- gemini-2.5-flash structured output: JSON schema enforced ✓
- gemini-2.5-flash function calling: tool_call returned with args ✓
- gemini-2.5-flash multimodal vision: structured image analysis from generated image ✓

### sharp (v0.34.5) + @napi-rs/canvas (v0.1.63)
- **sharp for:** resize (smart crop via `strategy.attention`), composite (logo overlay, semi-transparent bars via `input.create` with `channels: 4`), format conversion.
- **@napi-rs/canvas for:** text rendering with custom fonts. `GlobalFonts.registerFromPath(file, name)` — deterministic, zero fontconfig dependency. Render text to PNG buffer → feed to sharp `composite()`.
- **Why not sharp for text:** fontfile support is fragile — depends on Pango+fontconfig, OTF unreliable, macOS needs `PANGOCAIRO_BACKEND=fontconfig`, Docker needs `FONTCONFIG_PATH`. @napi-rs/canvas uses Skia (same as Chrome), no system font deps.
- **Smart crop:** `sharp.strategy.attention` — luminance + saturation + skin tone. Good for product shots.

### @adobe/firefly-apis (v2.0.1)
- CJS-only but works in ESM via interop. Ships own `.d.ts`.
- `FireflyClient({ clientId, clientSecret, scopes })` — constructor-based auth with auto-refresh. No need for separate TokenProvider.
- 7 methods: `generateImages`, `generateSimilarImages`, `generateObjectComposite`, `expandImage`, `fillImage`, `generateVideoV3`, `upload`.
- **Output images are pre-signed URLs expiring in 1 hour.** Must fetch immediately.
- Enterprise-only. ~$1k/month minimum.

### ESM TypeScript setup
- `"type": "module"` in package.json, `"module": "nodenext"` in tsconfig.
- All imports need `.js` extensions (e.g., `from './brief.js'`).
- `tsx` for dev runs (zero config, uses esbuild). `vitest` works out of box with ESM TS.
- `commander` v14 has proper ESM exports. `yaml` (v2.8) works via exports map.
- `@azure/storage-blob` v12.31 is ESM-native with dual exports.

### Cosine similarity
- 8 lines inline. At 3072 dims × 100 assets, brute force is sub-millisecond. No indexing needed for demo scale.
