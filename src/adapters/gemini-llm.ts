/**
 * Gemini adapter — implements LLMClient, MultimodalLLMClient, and EmbeddingClient.
 *
 * One SDK (@google/genai), one API key, three capabilities:
 * - Text LLM (gemini-2.5-flash): structured output, function calling
 * - Multimodal vision (same model): image analysis with JSON schema
 * - Text embeddings (gemini-embedding-001): for RAG asset retrieval
 *
 * This is why Gemini was chosen as the default: single billing surface,
 * single credential, covers every AI role in the pipeline.
 */

import { GoogleGenAI } from '@google/genai';
import { toJSONSchema, type ZodType } from 'zod';
import sharp from 'sharp';

// Zod v4 has built-in toJSONSchema — the third-party zod-to-json-schema package
// is incompatible with zod v4 (returns empty schemas). Use the native one.
import type {
  LLMClient,
  MultimodalLLMClient,
  EmbeddingClient,
  LLMMessage,
  LLMResponse,
  ToolDeclaration,
  ToolCall,
} from '../ports/llm-client.js';
import { withRetry, withTimeout, defaultIsRetryable } from '../infra/retry.js';
import { llmLimit } from '../infra/rate-limiter.js';
import { recordInvocationLlmCost } from '../infra/invocation-scope.js';

// Per-call timeout in ms. Critical for preview models like gemini-3.1-pro-
// preview that the SDK will silently internally-retry on a 503 storm — without
// a ceiling, a single call can wait minutes before surfacing, defeating the
// point of having fallbacks. Env-tunable; default 90s per attempt.
function readLlmTimeoutMs(): number {
  const raw = process.env.LLM_CALL_TIMEOUT_MS;
  if (!raw) return 90_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 90_000;
}

// Best-effort error label for fallback logs — pulls status/code/message out
// of whatever the SDK threw without dumping the full stack.
function errLabel(err: unknown): string {
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  return String(e.status ?? e.code ?? e.message ?? 'error');
}

// Strip markdown code fences from LLM responses.
// Gemini sometimes wraps JSON in ```json ... ``` even with structured output enabled.
// This is a known behavior — clean it before parsing.
function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

// Convert our ToolDeclaration to Gemini's format.
// Gemini uses its own Type enum — we map from JSON Schema types.
function toGeminiFunctionDecl(tool: ToolDeclaration) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters, // Gemini accepts JSON Schema directly via parametersJsonSchema
  };
}

// Convert our messages to Gemini's content format.
// Gemini doesn't use a "system" role — system is a separate config field.
function toGeminiContents(messages: LLMMessage[]) {
  return messages
    .filter((m) => m.role !== 'system') // system handled separately
    .map((m) => {
      const parts: Array<Record<string, unknown>> = [];

      if (typeof m.content === 'string') {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'image') {
            // Multimodal: inline image as base64
            parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
          }
        }
      }

      // Tool response messages need functionResponse format
      if (m.role === 'tool' && m.toolCallId) {
        return {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: m.toolCallId.split(':')[0] || 'unknown', // we encode name:id
                response: { result: typeof m.content === 'string' ? JSON.parse(m.content) : m.content },
                id: m.toolCallId,
              },
            },
          ],
        };
      }

      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });
}

// Rough per-1K-token pricing for cost estimation.
// These are approximate — actual billing depends on the specific model and tier.
const COST_PER_1K_INPUT = 0.00125;
const COST_PER_1K_OUTPUT = 0.005;
const COST_PER_EMBEDDING = 0.00001;

export class GeminiAdapter implements LLMClient, MultimodalLLMClient, EmbeddingClient {
  readonly name = 'gemini';
  private ai: GoogleGenAI;
  private model: string;
  // Ordered fallback chain — tried left-to-right when the primary model
  // returns 503 UNAVAILABLE after its normal retry budget is exhausted.
  // Preview models (gemini-3.1-pro-preview) have limited capacity and 503
  // frequently during spikes; quietly stepping down to a stable model keeps
  // the pipeline running instead of failing the whole run.
  private fallbackModels: string[];
  private embeddingModel: string;

  // Cumulative cost tracking — read by the pipeline after each run.
  totalCostUsd = 0;
  callCount = 0;

  constructor(opts: { apiKey: string; model?: string; embeddingModel?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? (process.env.LLM_MODEL || 'gemini-3.1-pro-preview');
    // Use `||` not `??` here: an empty-string env var (LLM_MODEL_FALLBACKS=)
    // should still fall back to the default chain. `??` only catches
    // undefined/null, so an explicit empty string would disable fallback
    // entirely — the exact failure mode we saw in prod where the primary
    // 503'd and no fallback was attempted.
    const fbRaw = process.env.LLM_MODEL_FALLBACKS || 'gemini-2.5-pro,gemini-2.5-flash,gemini-2.5-flash-lite';
    this.fallbackModels = fbRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== this.model);
    this.embeddingModel = opts.embeddingModel ?? 'gemini-embedding-001';
    // One-line diagnostic on construction so operators can verify the chain
    // was loaded as expected without having to enable debug logging.
    console.log(`[gemini] model=${this.model} fallbacks=[${this.fallbackModels.join(', ') || '(none)'}]`);
  }

  // Sticky-failover pointer: once the primary model 503s or network-fails,
  // remember the shift so subsequent calls start from the known-good model
  // instead of probing the broken one every time. Resets only on process
  // restart — the pipeline is short-lived, a few minutes at most.
  private stickyStartIndex = 0;

  // Run `fn(model)` through the chain: each non-final model gets ONE attempt
  // (fast fallback on capacity or network errors). The final model retains
  // the normal retry budget via `this.guarded`, so transient errors there
  // still get exponential-backoff retries before a hard failure.
  //
  // fn receives an `isLast` flag and chooses its own retry wrapper.
  private async withModelFallback<T>(fn: (model: string, isLast: boolean) => Promise<T>): Promise<T> {
    const fullChain = [this.model, ...this.fallbackModels];
    // Start from the sticky index, but never go past the last model.
    const startAt = Math.min(this.stickyStartIndex, fullChain.length - 1);
    let lastErr: unknown;
    for (let i = startAt; i < fullChain.length; i++) {
      const isLast = i === fullChain.length - 1;
      try {
        return await fn(fullChain[i], isLast);
      } catch (err) {
        lastErr = err;
        // Fall through on any retryable error (503, network, timeouts) — not
        // just capacity 503s. A transient undici "fetch failed" on the primary
        // shouldn't kill the pipeline when fallbacks are available.
        if (!defaultIsRetryable(err) || isLast) throw err;
        // Advance sticky pointer so the next call skips the broken model.
        if (i + 1 > this.stickyStartIndex) this.stickyStartIndex = i + 1;
        console.warn(
          `[gemini] ${fullChain[i]} failed (${errLabel(err)}) — falling back to ${fullChain[i + 1]} (sticky)`,
        );
      }
    }
    throw lastErr;
  }

  // Like `guarded` but without retries — used for non-final models in the
  // fallback chain where we'd rather fail fast and move to the next model.
  // Still gets the per-call timeout so a hung primary model can't stall the
  // whole chain; on timeout we throw TimeoutError → fallback advances.
  private guardedNoRetry<T>(fn: () => Promise<T>): Promise<T> {
    return llmLimit(() => withTimeout(fn, readLlmTimeoutMs()));
  }

  // Estimate and accumulate cost from token counts.
  // Reports to both the global running total (for end-of-run summaries) and
  // the current ctx.invoke() scope (so concurrent invocations attribute only
  // their own calls).
  private trackCost(tokens: { prompt: number; completion: number }): number {
    const cost = (tokens.prompt / 1000) * COST_PER_1K_INPUT + (tokens.completion / 1000) * COST_PER_1K_OUTPUT;
    this.totalCostUsd += cost;
    this.callCount++;
    recordInvocationLlmCost(cost);
    return cost;
  }

  // Wrap an outbound call with the shared concurrency limiter + retry/backoff.
  // llmLimit caps in-flight concurrency across the whole process (all jobs);
  // withRetry absorbs transient 429/503 spikes so a burst past the limiter
  // still completes without bubbling up a failure to the pipeline.
  // A per-attempt timeout keeps a single hung SDK call from pinning the
  // pipeline — on timeout we throw TimeoutError, which is retryable, so
  // withRetry will retry and (in the fallback path) the fallback chain
  // will move to the next model on the final attempt.
  private guarded<T>(fn: () => Promise<T>): Promise<T> {
    return llmLimit(() =>
      withRetry(fn, {
        timeoutMs: readLlmTimeoutMs(),
        onRetry: (attempt, delayMs, err) => {
          const status = (err as { status?: unknown; code?: unknown }).status ?? (err as { code?: unknown }).code;
          console.warn(`[gemini] ${status ?? 'error'} — retrying in ${delayMs}ms (attempt ${attempt})`);
        },
      }),
    );
  }

  // --- LLMClient ---

  async complete(opts: {
    system: string;
    messages: LLMMessage[];
    schema?: ZodType;
    tools?: ToolDeclaration[];
    forceToolUse?: boolean;
  }): Promise<LLMResponse> {
    // Build config — structured output and/or tool declarations
    const config: Record<string, unknown> = {
      systemInstruction: opts.system,
    };

    // Structured output via JSON schema (requires responseMimeType)
    if (opts.schema) {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = toJSONSchema(opts.schema);
    }

    // Tool declarations for function-calling agents
    if (opts.tools?.length) {
      config.tools = [
        {
          functionDeclarations: opts.tools.map(toGeminiFunctionDecl),
        },
      ];
      if (opts.forceToolUse) {
        config.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      }
    }

    const { resp, modelUsed } = await this.withModelFallback(async (model, isLast) => {
      const run = () =>
        this.ai.models.generateContent({
          model,
          contents: toGeminiContents(opts.messages),
          config,
        });
      const r = await (isLast ? this.guarded(run) : this.guardedNoRetry(run));
      return { resp: r, modelUsed: model };
    });

    // Extract tool calls if present
    const toolCalls: ToolCall[] | undefined = resp.functionCalls?.map((fc) => ({
      id: fc.id ?? `${fc.name}:${Date.now()}`,
      name: fc.name ?? 'unknown',
      args: (fc.args ?? {}) as Record<string, unknown>,
    }));

    // Estimate tokens from response metadata
    const tokens = {
      prompt: resp.usageMetadata?.promptTokenCount ?? 0,
      completion: resp.usageMetadata?.candidatesTokenCount ?? 0,
    };
    this.trackCost(tokens);

    return {
      text: toolCalls?.length ? undefined : resp.text ? stripCodeFences(resp.text) : undefined,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      tokens,
      model: modelUsed,
    };
  }

  // --- MultimodalLLMClient ---

  async analyzeImage(opts: {
    image: Buffer;
    mimeType: string;
    prompt: string;
    schema?: ZodType;
  }): Promise<{ text: string; tokens: { prompt: number; completion: number }; model: string }> {
    // Downscale image for vision analysis — the model internally downscales anyway.
    // 540px max dimension cuts payload ~4x (1.6MB → ~400KB) with no quality loss
    // for brand/legal/asset analysis tasks.
    const downscaled = await sharp(opts.image)
      .resize(540, 540, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Build multimodal content: image + text prompt
    const contents = [
      { inlineData: { mimeType: 'image/jpeg', data: downscaled.toString('base64') } },
      { text: opts.prompt },
    ];

    const config: Record<string, unknown> = {};
    if (opts.schema) {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = toJSONSchema(opts.schema);
    }

    const { resp, modelUsed } = await this.withModelFallback(async (model, isLast) => {
      const run = () =>
        this.ai.models.generateContent({
          model,
          contents,
          config,
        });
      const r = await (isLast ? this.guarded(run) : this.guardedNoRetry(run));
      return { resp: r, modelUsed: model };
    });

    const tokens = {
      prompt: resp.usageMetadata?.promptTokenCount ?? 0,
      completion: resp.usageMetadata?.candidatesTokenCount ?? 0,
    };
    this.trackCost(tokens);

    return {
      text: resp.text ? stripCodeFences(resp.text) : '',
      tokens,
      model: modelUsed,
    };
  }

  // --- EmbeddingClient ---

  async embed(input: string, opts?: { dimensions?: number }): Promise<number[]> {
    const resp = await this.guarded(() =>
      this.ai.models.embedContent({
        model: this.embeddingModel,
        contents: input,
        config: { outputDimensionality: opts?.dimensions ?? 768 },
      }),
    );

    // embedContent returns { embeddings: [{ values: number[] }] }
    const values = resp.embeddings?.[0]?.values;
    if (!values) throw new Error('Embedding returned no values');

    // Embeddings are priced per-call, not per-token. Bill a flat rate.
    this.totalCostUsd += COST_PER_EMBEDDING;
    this.callCount++;
    recordInvocationLlmCost(COST_PER_EMBEDDING);

    return values;
  }
}
