/**
 * Prompt Engineer agent — crafts diffusion-optimized prompts from creative concepts.
 *
 * Takes the Creative Director's concept + product info + optional style reference
 * and produces a detailed prompt for Imagen/Firefly/DALL-E. The output includes:
 * - The main prompt (optimized for photorealistic product photography)
 * - A negative prompt (what to avoid — common noise that competes with text overlay)
 * - Reasoning (why these choices — for the audit trail)
 *
 * This is where prompt engineering skill shows: matching brand tone, audience
 * expectations, and the specific diffusion model's prompt conventions.
 */

import { z } from 'zod';
import type { Agent } from './base.js';
import type { RunContext } from '../infra/run-context.js';

// Input: creative concept from the director + product info
export interface PromptEngineerInput {
  productId: string;
  productName: string;
  productDescription: string;
  generationDirection: string; // from CreativePlan.ProductPlan
  brandTone?: string;
  brandPalette: string[];
  audience: string;
  region: string;
  referenceDescription?: string; // from the style reference asset's metadata
  // True when the reference is a declared brief asset (must preserve the
  // exact product subject, not just the mood). False when it's a RAG-found
  // style inspiration where we want the vibe but a new subject.
  preserveSubject?: boolean;
  // Most recent ReAct-loop feedback — merged issues+suggestions from
  // brand-auditor and subject-preservation on the previous attempt.
  retryFeedback?: string;
  // 1-indexed attempt number and total budget — lets the prompt express
  // urgency ("attempt 4 of 11") and flip into strict compliance mode.
  attemptNumber?: number;
  maxAttempts?: number;
  // Full history of prior failures. LLM retry loops often oscillate
  // (fix A, regress B; fix B, regress A). Showing every past complaint
  // keeps all constraints simultaneously in view.
  priorFailures?: Array<{ attempt: number; feedback: string }>;
}

// Zod schema for structured prompt output
const PromptOutputSchema = z.object({
  prompt: z.string().describe('Detailed prompt optimized for photorealistic image generation'),
  negativePrompt: z.string().describe('What to avoid: common noise, off-brand elements'),
  reasoning: z.string().describe('Why these prompt choices — for audit trail'),
});

export type PromptOutput = z.infer<typeof PromptOutputSchema>;

export class PromptEngineerAgent implements Agent<PromptEngineerInput, PromptOutput> {
  readonly name = 'prompt-engineer';

  // Build the binding-feedback block that leads the user message on retries.
  // Shows the attempt counter, the current validator feedback, and an
  // enumerated history of prior failures so the model sees every constraint
  // simultaneously — not just the last complaint.
  private buildRetryBlock(input: PromptEngineerInput): string {
    const attemptLine =
      input.attemptNumber && input.maxAttempts
        ? `ATTEMPT ${input.attemptNumber} OF ${input.maxAttempts}`
        : 'RETRY ATTEMPT';

    const history = (input.priorFailures ?? [])
      .map((f) => `--- Attempt ${f.attempt} feedback ---\n${f.feedback}`)
      .join('\n\n');

    return [
      `=== ⚠ BINDING VALIDATION FEEDBACK — ${attemptLine} ===`,
      'The auditor has rejected prior output. You MUST address every item below.',
      'Treat this as hard requirements, not suggestions.',
      '',
      'CURRENT FEEDBACK (most recent rejection):',
      input.retryFeedback ?? '(none)',
      history ? '\n--- FULL FAILURE HISTORY ---\n' + history : '',
      '=== END BINDING FEEDBACK ===',
      '',
    ].join('\n');
  }

  async execute(input: PromptEngineerInput, ctx: RunContext): Promise<PromptOutput> {
    const isRetry = !!input.retryFeedback;

    // System prompt — gives the engineer its role and optimization targets.
    // On retries, switch into a strict compliance mode that elevates auditor
    // feedback above aesthetic goals. Fresh attempts still get the creative-
    // first framing so first-pass outputs don't feel over-constrained.
    const baseSystem = [
      'You are a prompt engineer specializing in product photography for social ad campaigns.',
      'Given a creative concept and product info, write a detailed prompt optimized for',
      'Imagen 4 (photorealistic image generation).',
      '',
      'Prompt engineering guidelines:',
      '- Lead with the subject, then describe environment, lighting, and mood',
      '- Include camera terms: "shallow depth of field", "studio lighting", "4k"',
      '- Reference the brand palette colors naturally (e.g., "warm copper tones")',
      '- Avoid text in the image — text overlay is added separately by the Composer',
      '- Keep prompts under 300 words — longer prompts lose focus',
      '',
      'The negative prompt should exclude:',
      '- Noise that competes with later text overlay (existing text, watermarks)',
      '- Off-brand aesthetics (if brand is minimal, exclude "cluttered", etc.)',
      '- Common generation artifacts (blurry, low quality, distorted)',
    ];

    // When preserveSubject is true, a user-declared reference image is
    // attached to the generation call. It could be the product itself,
    // a lifestyle shot containing the product, packaging, or any other
    // user-chosen reference — we don't know the subject type in advance.
    //
    // The critical failure mode (observed in prior runs): even with
    // "reproduce exactly" phrasing, scene directives (palette hex codes,
    // mood words like "minimalist", "crisp") bleed into subject-land.
    // The model reads "off-white countertop, minimalist, crisp morning"
    // and re-colorizes the whole composition INCLUDING the subject to
    // match. Fix is to STRUCTURALLY separate SUBJECT from SCENE in the
    // output prompt, not just prepend "reproduce exactly."
    const preserveSubjectSystem = input.preserveSubject
      ? [
          '',
          '=== REFERENCE IMAGE PROTOCOL (CRITICAL) ===',
          'A user-declared reference image is attached to the generation call.',
          'Treat whatever appears in the reference as GROUND TRUTH. You do NOT',
          'know in advance whether it is packaging, a product shot, a lifestyle',
          'scene, or something else — do not assume.',
          '',
          'Your generated prompt MUST use this exact structural format:',
          '',
          '  SUBJECT (unchanged from reference):',
          '  [One short sentence: reproduce the subject from the attached',
          '  reference image verbatim — keep all colors, materials, branding,',
          '  text, and design details exactly as shown. Do not describe the',
          "  subject's colors or appearance in words.]",
          '',
          '  SCENE (to generate around the subject):',
          '  [Describe the background, surface, lighting, props, composition,',
          '  and mood. Brand palette and scene directives apply HERE ONLY.]',
          '',
          '  COMPOSITION:',
          '  [Aspect ratio cues, camera framing, focal length.]',
          '',
          'WHY THIS STRUCTURE MATTERS:',
          '- Prior runs put scene directives inline with "reproduce the box"',
          '  and the model re-colorized the box to match the scene palette',
          '  ("#F5F5F0 countertop" caused a white box; "minimalist" caused a',
          '  redesigned label). The explicit SUBJECT/SCENE split prevents the',
          '  bleed.',
          '- The model reads the SUBJECT block as "keep as-is" and the SCENE',
          '  block as "generate new content around it" — two different modes.',
          '',
          'HARD RULES for the SUBJECT block:',
          "- Do NOT list the subject's colors or palette. The reference has",
          '  them; restating invites the model to re-color.',
          '- Do NOT apply the brand palette to the subject. Brand palette is',
          '  scene-only when preserving a reference.',
          '- Do NOT invent adjectives ("premium", "minimalist", "elegant",',
          '  "modern"). They cause reinterpretation.',
          '- Do NOT restate any text, names, logos, or labels from the',
          '  reference. The reference already has the real text; retyping',
          '  invites hallucinated misspellings.',
          '- Do NOT paraphrase the `referenceDescription` into the SUBJECT',
          '  block. That description is YOUR context only; the image model',
          '  sees the reference image directly.',
          '',
          'Negative prompt MUST include: "redesigned subject, altered from',
          'reference, re-colored subject, palette applied to subject,',
          'invented text, different branding, new logo".',
          '=== END PROTOCOL ===',
        ]
      : [];
    baseSystem.push(...preserveSubjectSystem);

    const retrySystem = [
      '',
      '=== STRICT COMPLIANCE MODE (retry attempt) ===',
      'Previous attempts failed validation. Auditor feedback is BINDING, not',
      'advisory — it overrides aesthetic judgment when the two conflict.',
      '',
      'Rules:',
      '1. Address EVERY listed violation from prior attempts. If attempt 2 fixed',
      '   issue A but attempt 3 regressed issue B, you must fix BOTH this pass.',
      '2. If a violation concerns brand palette, include palette hex codes',
      '   literally in both the prompt AND negative prompt (exclude off-palette',
      '   colors explicitly, e.g., "no teal, no bronze").',
      '3. If a violation concerns subject preservation, the reference-image',
      '   call is attached — compose around it, do NOT redesign the product.',
      '4. Use the "reasoning" field to list which violations you addressed and',
      '   HOW. This is how the audit trail verifies compliance.',
      '5. Do not introduce NEW creative flourishes in retry mode — the goal is',
      '   to pass validation, not to explore new directions.',
    ];

    const system = (isRetry ? [...baseSystem, ...retrySystem] : baseSystem).join('\n');

    // Build the user message. On retries, lead with the binding feedback
    // block so it anchors the model's attention before the creative context.
    // Order matters: what appears first gets more weight in most decoders.
    const retryBlock = isRetry ? this.buildRetryBlock(input) : null;
    const userParts: string[] = [];
    if (retryBlock) userParts.push(retryBlock);
    userParts.push(
      `Product: ${input.productName} — ${input.productDescription}`,
      `Creative direction: ${input.generationDirection}`,
      `Brand tone: ${input.brandTone ?? 'not specified'}`,
      `Brand palette: ${input.brandPalette.join(', ')}`,
      `Audience: ${input.audience}`,
      `Region: ${input.region}`,
    );
    if (input.referenceDescription) {
      userParts.push(
        input.preserveSubject
          ? [
              '',
              'Declared reference — a reference image IS attached to the generation',
              'call. The description below is FOR YOUR UNDERSTANDING only — do NOT',
              'paraphrase it into the output prompt. Instead, instruct the image',
              'model to reproduce whatever the reference shows verbatim, and',
              'describe only what should change around it.',
              '',
              `Reference context: ${input.referenceDescription}`,
            ].join('\n')
          : `\nStyle reference asset (match this mood, do NOT copy the subject):\n${input.referenceDescription}`,
      );
    } else if (input.preserveSubject) {
      // No description loaded, but we still have the image attached.
      userParts.push(
        '',
        'A reference image IS attached to the generation call. Instruct the image',
        'model to reproduce whatever the reference shows verbatim, and describe',
        'only what should change around it.',
      );
    }
    // Repeat the binding summary at the END too so it frames the response.
    // LLMs weight first and last prompt regions most; bracketing retry
    // feedback on both sides makes it genuinely hard to ignore.
    if (retryBlock) {
      userParts.push(
        '\n=== REMINDER ===',
        'Output will be AUTO-REJECTED if it does not address every listed violation above.',
        'Before finalizing, re-read each violation and confirm your prompt targets it.',
      );
    }
    const userMessage = userParts.filter(Boolean).join('\n');

    const resp = await ctx.adapters.llm.complete({
      system,
      messages: [{ role: 'user', content: userMessage }],
      schema: PromptOutputSchema,
    });

    return PromptOutputSchema.parse(JSON.parse(resp.text!));
  }
}
