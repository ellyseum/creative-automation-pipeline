# Creative Automation Pipeline — Claude Code Project Config

## What This Is

Adobe FDE take-home: CLI pipeline that generates social ad creatives from a campaign brief using GenAI. Clean Architecture, multi-agent orchestration, RAG-based asset retrieval, full audit trail.

## Architecture

Clean Architecture / hexagonal. Dependencies flow inward only:

- **`src/domain/`** — pure types + zod schemas. Zero external imports. Everything else can depend on this.
- **`src/ports/`** — interfaces (LLMClient, ImageGenerator, Storage, AssetIndex). Depend on domain only.
- **`src/agents/`** — focused AI workers, each with a single job. Depend on domain + ports.
- **`src/use-cases/`** — pipeline orchestration. Depends on domain + ports + agents.
- **`src/adapters/`** — concrete implementations of ports (Gemini, Imagen, Firefly, Azure, LocalFS). Depend on ports + external SDKs.
- **`src/infra/`** — cross-cutting (logger, audit writer, cost tracker, env loader). Outermost ring.
- **`src/commands/`** — CLI subcommands. Outermost ring.

**Never import from adapters in agents/use-cases.** Always go through port interfaces.

## Code Conventions

- **ESM TypeScript** — `"type": "module"` in package.json, `"module": "nodenext"` in tsconfig.
- **Import extensions required** — always `.js` in import paths: `import { Brief } from './brief.js'`
- **Descriptive comments on every decision** — this code will be explained line-by-line in an interview. Comment the WHY, not the WHAT.
- **Agent prompts are inline** — each agent's system prompt lives in its source file, not in separate prompt files. Keeps code + prompt colocated for defensibility.
- **No LangChain/AutoGen** — hand-written agent orchestration for full control.

## Testing

- **Framework:** vitest (fast, ESM TypeScript native)
- **Unit tests:** colocated `*.test.ts` next to source in `src/`
- **E2E tests:** `e2e/` directory
- **Run:** `npm test` (all), `npm run test:unit`, `npm run test:e2e`
- **Integration tests** that need API keys skip gracefully when keys aren't set

## Environment Setup

1. Copy `.env.example` → `.env`, fill in `GEMINI_API_KEY`
2. `npm install`
3. `npm run pipeline -- run briefs/example.yaml`

For Azure Blob storage: `docker-compose up -d` starts Azurite, then set `STORAGE_BACKEND=azure` in `.env`.

## Adding a New Adapter

1. Create `src/adapters/<name>.ts` implementing the relevant port interface
2. Register it in `src/adapters/factory.ts`
3. Add an env var to select it (e.g., `IMAGE_PROVIDER=newprovider`)
4. Update `.env.example` with the new option

## Adding a New Agent

1. Create `src/agents/<name>.ts` implementing `Agent<I, O>` from `src/agents/base.ts`
2. Define its input/output types in `src/domain/`
3. Wire it into the orchestrator (`src/use-cases/generate-creatives.ts`)
4. Add a subcommand entry in `src/commands/agent.ts` for standalone invocation

## Key Files

- `src/domain/brief.ts` — zod schema for campaign brief YAML. Update schema HERE, not in parsing logic.
- `src/adapters/factory.ts` — adapter resolution. All env-var-based provider switching lives here.
- `src/use-cases/generate-creatives.ts` — THE orchestrator. All control flow, ReAct loops, and state machine logic.
- `src/infra/run-context.ts` — the `invoke()` wrapper that logs every agent call. Every agent goes through this.

## Security

- Never commit `.env` or API keys
- `.gitignore` excludes `.env`, `output/`, `.embeddings/`
- Vault pattern for local API key usage during development
