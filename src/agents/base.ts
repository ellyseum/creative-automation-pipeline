/**
 * Agent base interface — every agent in the pipeline implements this.
 *
 * Generic over Input and Output types so each agent's contract is
 * explicit and type-checked at compile time. The RunContext.invoke()
 * wrapper calls execute() and handles all cross-cutting concerns
 * (logging, audit, cost tracking).
 *
 * Agents are pure application logic — they depend on ports (interfaces),
 * never on adapters (implementations). This makes them unit-testable
 * with stubbed dependencies.
 */

import type { RunContext } from '../infra/run-context.js';

export interface Agent<I, O> {
  // Human-readable name — used in audit logs, stdout, and CLI subcommands.
  readonly name: string;

  // Execute the agent's logic. Receives the RunContext for accessing
  // adapters (llm, imageGen, storage) and sub-invoking other agents.
  execute(input: I, ctx: RunContext): Promise<O>;
}
