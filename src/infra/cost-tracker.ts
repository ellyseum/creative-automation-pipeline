/**
 * Cost tracker — accumulates estimated USD costs across agents and products.
 *
 * Each agent invocation reports its estimated cost. The tracker aggregates
 * by agent name, product ID, and provider for the run manifest's cost
 * summary. All costs are estimates — actual billing depends on the provider.
 */

interface CostEntry {
  agent: string;
  productId?: string;
  provider: string;
  costUsd: number;
}

export class CostTracker {
  private entries: CostEntry[] = [];

  // Record a cost from an agent invocation.
  add(agent: string, costUsd: number, provider: string, productId?: string): void {
    if (costUsd <= 0) return; // skip zero-cost entries (deterministic agents)
    this.entries.push({ agent, productId, provider, costUsd });
  }

  // Total estimated cost for the entire run.
  get totalUsd(): number {
    return this.entries.reduce((sum, e) => sum + e.costUsd, 0);
  }

  // Group costs by a key — used for the manifest's cost breakdown.
  private groupBy(key: keyof CostEntry): Record<string, number> {
    const groups: Record<string, number> = {};
    for (const e of this.entries) {
      const k = String(e[key] ?? 'unknown');
      groups[k] = (groups[k] ?? 0) + e.costUsd;
    }
    return groups;
  }

  // Full cost summary — written to manifest.json.
  summary(): {
    totalUsdEst: number;
    byAgent: Record<string, number>;
    byProduct: Record<string, number>;
    byProvider: Record<string, number>;
  } {
    return {
      totalUsdEst: this.totalUsd,
      byAgent: this.groupBy('agent'),
      byProduct: this.groupBy('productId'),
      byProvider: this.groupBy('provider'),
    };
  }
}
