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

import { GoogleGenAI, Type } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ZodType } from 'zod';

// Note: ZodType from zod v4 has a different internal shape than what zod-to-json-schema
// expects. We cast to 'any' at the boundary — runtime behavior is correct,
// only the type signature drifts. Known zod v4 migration issue.
import type {
  LLMClient, MultimodalLLMClient, EmbeddingClient,
  LLMMessage, LLMResponse, ToolDeclaration, ToolCall,
} from '../ports/llm-client.js';

// Convert our ToolDeclaration to Gemini's format.
// Gemini uses its own Type enum — we map from JSON Schema types.
function toGeminiFunctionDecl(tool: ToolDeclaration) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,  // Gemini accepts JSON Schema directly via parametersJsonSchema
  };
}

// Convert our messages to Gemini's content format.
// Gemini doesn't use a "system" role — system is a separate config field.
function toGeminiContents(messages: LLMMessage[]) {
  return messages
    .filter(m => m.role !== 'system')   // system handled separately
    .map(m => {
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
          parts: [{
            functionResponse: {
              name: m.toolCallId.split(':')[0] || 'unknown',  // we encode name:id
              response: { result: typeof m.content === 'string' ? JSON.parse(m.content) : m.content },
              id: m.toolCallId,
            },
          }],
        };
      }

      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });
}

export class GeminiAdapter implements LLMClient, MultimodalLLMClient, EmbeddingClient {
  readonly name = 'gemini';
  private ai: GoogleGenAI;
  private model: string;
  private embeddingModel: string;

  constructor(opts: { apiKey: string; model?: string; embeddingModel?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? 'gemini-2.5-flash';
    this.embeddingModel = opts.embeddingModel ?? 'gemini-embedding-001';
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
      config.responseJsonSchema = zodToJsonSchema(opts.schema as any);
    }

    // Tool declarations for function-calling agents
    if (opts.tools?.length) {
      config.tools = [{
        functionDeclarations: opts.tools.map(toGeminiFunctionDecl),
      }];
      if (opts.forceToolUse) {
        config.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      }
    }

    const resp = await this.ai.models.generateContent({
      model: this.model,
      contents: toGeminiContents(opts.messages),
      config,
    });

    // Extract tool calls if present
    const toolCalls: ToolCall[] | undefined = resp.functionCalls?.map(fc => ({
      id: fc.id ?? `${fc.name}:${Date.now()}`,
      name: fc.name ?? 'unknown',
      args: (fc.args ?? {}) as Record<string, unknown>,
    }));

    // Estimate tokens from response metadata
    const tokens = {
      prompt: resp.usageMetadata?.promptTokenCount ?? 0,
      completion: resp.usageMetadata?.candidatesTokenCount ?? 0,
    };

    return {
      text: toolCalls?.length ? undefined : (resp.text ?? undefined),
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      tokens,
      model: this.model,
    };
  }

  // --- MultimodalLLMClient ---

  async analyzeImage(opts: {
    image: Buffer;
    mimeType: string;
    prompt: string;
    schema?: ZodType;
  }): Promise<{ text: string; tokens: { prompt: number; completion: number }; model: string }> {
    // Build multimodal content: image + text prompt
    const contents = [
      { inlineData: { mimeType: opts.mimeType, data: opts.image.toString('base64') } },
      { text: opts.prompt },
    ];

    const config: Record<string, unknown> = {};
    if (opts.schema) {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = zodToJsonSchema(opts.schema as any);
    }

    const resp = await this.ai.models.generateContent({
      model: this.model,
      contents,
      config,
    });

    return {
      text: resp.text ?? '',
      tokens: {
        prompt: resp.usageMetadata?.promptTokenCount ?? 0,
        completion: resp.usageMetadata?.candidatesTokenCount ?? 0,
      },
      model: this.model,
    };
  }

  // --- EmbeddingClient ---

  async embed(input: string, opts?: { dimensions?: number }): Promise<number[]> {
    const resp = await this.ai.models.embedContent({
      model: this.embeddingModel,
      contents: input,
      config: { outputDimensionality: opts?.dimensions ?? 768 },
    });

    // embedContent returns { embeddings: [{ values: number[] }] }
    const values = resp.embeddings?.[0]?.values;
    if (!values) throw new Error('Embedding returned no values');
    return values;
  }
}
