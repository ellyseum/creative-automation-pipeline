# Creative Automation Pipeline — Design Document

## Problem

A global consumer goods company launches hundreds of localized social ad campaigns monthly. Creating and localizing creative variants is manual, slow, expensive, and error-prone. Brand consistency suffers across decentralized agencies and markets. Approval cycles bottleneck on multiple stakeholders. Performance data is siloed.

This pipeline automates the creative asset generation workflow using GenAI — from campaign brief to publish-ready social creatives with brand compliance and legal checks built in.

## Architecture

Clean Architecture (hexagonal / ports & adapters). Dependencies flow inward only:

```
┌────────────────────────────────────────────────────────────────┐
│  Drivers (CLI, Docker)                                         │
│   ┌────────────────────────────────────────────────────────┐   │
│   │  Adapters (Gemini, Imagen, Firefly, Azure, LocalFS)    │   │
│   │   ┌────────────────────────────────────────────────┐   │   │
│   │   │  Use Cases + Agents (orchestrator, 9 agents)   │   │   │
│   │   │   ┌────────────────────────────────────────┐   │   │   │
│   │   │   │  Domain (Brief, Creative, Plan, etc.)  │   │   │   │
│   │   │   └────────────────────────────────────────┘   │   │   │
│   │   └────────────────────────────────────────────────┘   │   │
│   └────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

| Layer | Folder | Depends on | Example |
|-------|--------|-----------|---------|
| Domain | `src/domain/` | Nothing | Brief schema, Creative type, AgentInvocation |
| Use Cases + Agents | `src/use-cases/`, `src/agents/` | Domain + Ports | GenerateCreatives orchestrator, CreativeDirector agent |
| Ports | `src/ports/` | Domain only | LLMClient, ImageGenerator, Storage interfaces |
| Adapters | `src/adapters/` | Ports + external SDKs | GeminiLLM, ImagenGenerator, LocalFsStorage |
| Drivers / Infra | `src/cli.ts`, `src/infra/` | Everything | Commander CLI, logger, audit writer |

## Pipeline Flow

```
Brief (YAML)
  │
  ▼
[Asset Analyzer]     — preprocess: multimodal LLM describes each image in library
  │                     → structured metadata + text embeddings → .embeddings/index.json
  ▼
[Creative Director]  — LLM with search_assets() tool (ReAct pattern)
  │                     → queries library during planning, returns CreativePlan:
  │                       per-product strategy (reuse / hybrid / generate)
  ▼
Per product:
  │
  ├─ reuse    → load matched asset from storage
  ├─ hybrid   → load reference + [Prompt Engineer] + [Hero Generator]
  └─ generate → [Prompt Engineer] + [Hero Generator]
  │
  ▼
[Brand Auditor]      — hybrid: deterministic histogram + multimodal LLM
  │                     ↺ ReAct: on fail, revise prompt + regenerate (max 2 retries)
  ▼
Per aspect ratio (1:1, 9:16, 16:9):
  │
  ├─ [Localizer]       — LLM cultural adaptation (not literal translation)
  ├─ [Composer]        — deterministic: sharp for resize+composite, SVG text overlay
  ├─ [Brand Auditor]   — advisory: flags composition issues for human review
  └─ [Legal Reviewer]  — hybrid: regex blocklist + multimodal LLM
  ▼
[Report Writer]      — LLM → markdown executive summary
  │
  ▼
Output: organized folders + manifest.json + report.md + audit.jsonl
```

## Agent Catalog

| # | Agent | AI Type | Input | Output |
|---|-------|---------|-------|--------|
| 0 | Asset Analyzer | Multimodal LLM | Image bytes | Structured metadata + embedding |
| 1 | Creative Director | LLM + tool calling | Brief + asset library | CreativePlan (per-product strategy) |
| 2 | Prompt Engineer | LLM | Concept + product + reference | Diffusion-optimized prompt |
| 3 | Hero Generator | Diffusion (Imagen 4) | Prompt | Image bytes |
| 4 | Brand Auditor | Hybrid: deterministic + multimodal LLM | Image + brand guide | Pass/fail + feedback |
| 5 | Localizer | LLM | Message + region | Culturally-adapted text |
| 6 | Composer | Deterministic (sharp + canvas) | Hero + text + brand assets + ratio | Final creative PNG |
| 7 | Legal Reviewer | Hybrid: regex + multimodal LLM | Creative + text + region | Flags + verdict |
| 8 | Report Writer | LLM | Run manifest | Markdown summary |

## Ports & Adapters

| Port | Ships | Stubbed (prod target) |
|------|-------|----------------------|
| `LLMClient` | GeminiLLM (`gemini-2.5-flash`) | OpenAI (fallback) |
| `MultimodalLLMClient` | GeminiLLM (same adapter, multimodal) | — |
| `ImageGenerator` | ImagenGenerator (`imagen-4.0-fast`) | FireflyGenerator (Adobe enterprise) |
| `Storage` | LocalFsStorage, AzureBlobStorage (via Azurite) | Real Azure (same adapter, different connection string) |
| `AssetIndex` | JsonAssetIndex (in-memory cosine sim) | Azure AI Search, pgvector (noted in README) |

All adapters implement the same port interface. Swapping providers = one env var change.

## Decision Log

1. **Clean Architecture** — Domain depends on nothing. Use cases depend on ports only. Adapters are outer ring. Testability and provider-swapping fall out naturally.

2. **Gemini for all AI roles** — `gemini-2.5-flash` (LLM + multimodal), `imagen-4.0-fast` (diffusion), `gemini-embedding-001` (embeddings). One API key, one SDK, one billing surface. For a demo, this eliminates credential management complexity.

3. **Adobe Firefly adapter is the production target** — Real `@adobe/firefly-apis` SDK code, but gated behind enterprise IMS credentials. Falls back gracefully. Shows awareness of Adobe's ecosystem without blocking the demo on access we don't have.

4. **RAG via analyzed descriptions, not raw pixel embeddings** — Asset Analyzer produces inspectable metadata first, then embeds the description text. Why: (a) descriptions are auditable — you can see WHY a match ranked where it did, (b) text embeddings are cheaper and more stable than multimodal embeddings, (c) the metadata feeds other agents (Brand Auditor uses dominant_colors, Composer uses subject_location).

5. **Creative Director uses retriever as a tool (ReAct)** — Agentic pattern, not linear pipeline. Director queries the library during planning and makes informed decisions about reuse vs. generation. This is the core architectural signal: LLMs orchestrating other systems, not just generating content.

6. **ReAct retry loops with structured feedback** — Brand Auditor's failure report feeds specific suggestions back to the Prompt Engineer (not "try again" — "add warm tones, increase brand color saturation"). Bounded: max 2 retries for hero generation, max 1 for composition. Cost-capped.

7. **Per-agent JSONL audit trail** — Every agent invocation is logged with input/output artifact references. JSONL (not SQLite, not DB) because: append-only, lock-free, warehouse-ingestible, grep-friendly, trivially replayable. Supports cost attribution, compliance, and debugging.

8. **Platform safe zones in Composer** — 9:16 templates avoid top 300px (IG/TikTok profile bar) and bottom 400px (reply input). 16:9 avoids bottom 100px (player controls). This is the kind of production detail that separates "works in a demo" from "works in production."

9. **Idempotent asset analysis** — Indexed by sha256 of file contents. Re-analyzing only happens when an asset changes. At production scale (10k+ assets), this is the difference between a 30-second startup and a 30-minute one.

10. **No LangChain / AutoGen / CrewAI** — Hand-written agent orchestration for full control and line-by-line defensibility. These frameworks add value for dynamic tool routing and complex memory management; this pipeline is focused enough that the abstraction would obscure more than it helps.

## Testing

| Tier | Scope | Dependencies | Example |
|------|-------|-------------|---------|
| Unit | Domain schemas, placement algorithm, cost tracker | None (pure logic) | `brief.test.ts`, `composer.test.ts` |
| Integration | Adapters with real/mock backends | Gemini API, Azurite, temp dirs | `gemini-llm.test.ts`, `local-fs.test.ts` |
| E2E | Full pipeline run | Stub or real adapters | `pipeline.test.ts` |

Integration tests that require API keys are skipped when keys aren't set (CI-friendly).

## Non-Goals

- **Web UI is a demo layer** — Added as a simple wrapper around the CLI pipeline for visual demos. Not production-hardened (no auth, no input sanitization, in-memory job queue).
- **No authentication** — Runs locally with env-var credentials.
- **No scheduling / cron** — Manual invocation only. Scheduling is noted in scaling section.
- **No real-time streaming** — Batch pipeline, not streaming. Results written to disk.
- **No multi-language frontend** — Localization is in the pipeline (LLM-driven), not in a UI.
- **No model fine-tuning** — Uses foundation models as-is with prompt engineering.

## Scaling Notes (what changes at production scale)

| At demo scale | At 100 campaigns/day | At 10,000/day |
|--------------|---------------------|---------------|
| Local FS storage | Azure Blob / S3 | CDN-fronted object storage |
| In-memory cosine search | Azure AI Search / pgvector | Dedicated vector DB with HNSW index |
| JSONL audit on disk | Stream to Snowflake/BigQuery | Real-time event pipeline (Kafka/EventGrid) |
| Sequential execution | Parallel per-product | Queue-based: SQS/EventGrid per product |
| Manual CLI invocation | Cron + webhooks | Event-driven: new brief → auto-trigger |
| Single-machine | Containerized (Docker) | Kubernetes / Azure Container Apps |
| No caching | Content-addressed hero cache | Distributed cache with TTL |
| Cost tracking in manifest | Per-execution billing table | Real-time budget enforcement |
