/**
 * LLM client port — what agents need from a language model.
 *
 * Three capabilities in one port because most providers (Gemini, OpenAI)
 * offer all three through the same SDK and billing surface. Adapters
 * that only support a subset can throw "not implemented" for the rest.
 *
 * Structured output (via JSON schema) is critical — every agent returns
 * typed JSON, not free-form text. This makes the pipeline deterministic
 * and auditable at every step.
 */

import type { ZodType } from 'zod';

// A message in a conversation — matches the OpenAI-style role/content shape
// that both Gemini and OpenAI SDKs understand.
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  toolCallId?: string;            // for role='tool' responses
}

// A function/tool declaration for tool-calling agents (e.g., Creative Director).
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema object
}

// A tool call returned by the model.
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// Result of a complete() call — either text or tool calls (not both).
export interface LLMResponse {
  text?: string;                  // present when model returns text
  toolCalls?: ToolCall[];         // present when model wants to call tools
  tokens: { prompt: number; completion: number };
  model: string;
}

/**
 * Text LLM client — text in, structured text out.
 * Used by: Creative Director, Prompt Engineer, Localizer, Report Writer.
 */
export interface LLMClient {
  readonly name: string;

  // Generate a completion with optional structured output (JSON schema).
  complete(opts: {
    system: string;
    messages: LLMMessage[];
    schema?: ZodType;           // if provided, model returns JSON matching this schema
    tools?: ToolDeclaration[];    // if provided, model may return tool_calls
    forceToolUse?: boolean;       // if true, model MUST call a tool
  }): Promise<LLMResponse>;
}

/**
 * Multimodal LLM client — images + text in, structured text out.
 * Used by: Asset Analyzer, Brand Auditor, Legal Reviewer, Final QA.
 */
export interface MultimodalLLMClient {
  readonly name: string;

  // Analyze an image with a prompt, return structured output.
  analyzeImage(opts: {
    image: Buffer;
    mimeType: string;             // "image/png" | "image/jpeg"
    prompt: string;
    schema?: ZodType;           // structured output schema
  }): Promise<{ text: string; tokens: { prompt: number; completion: number }; model: string }>;
}

/**
 * Embedding client — text or image in, float vector out.
 * Used by: Asset Analyzer (index), Creative Director (search query).
 */
export interface EmbeddingClient {
  readonly name: string;

  // Embed a text string into a vector.
  embed(input: string, opts?: { dimensions?: number }): Promise<number[]>;
}
