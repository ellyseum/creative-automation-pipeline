/**
 * Cost tracker tests — verifies accumulation and groupBy logic.
 */

import { describe, it, expect } from 'vitest';
import { CostTracker } from './cost-tracker.js';

describe('CostTracker', () => {
  it('starts at zero', () => {
    const ct = new CostTracker();
    expect(ct.totalUsd).toBe(0);
  });

  it('accumulates costs', () => {
    const ct = new CostTracker();
    ct.add('prompt-engineer', 0.001, 'gemini', 'prod-a');
    ct.add('hero-generator', 0.02, 'imagen', 'prod-a');
    ct.add('brand-auditor', 0.003, 'gemini', 'prod-b');
    expect(ct.totalUsd).toBeCloseTo(0.024);
  });

  it('ignores zero-cost entries', () => {
    const ct = new CostTracker();
    ct.add('composer', 0, 'local', 'prod-a');
    ct.add('localizer', 0.001, 'gemini');
    const s = ct.summary();
    expect(Object.keys(s.byAgent)).toEqual(['localizer']);
  });

  it('groups by agent', () => {
    const ct = new CostTracker();
    ct.add('auditor', 0.01, 'gemini', 'a');
    ct.add('auditor', 0.01, 'gemini', 'b');
    ct.add('generator', 0.02, 'imagen', 'a');
    const s = ct.summary();
    expect(s.byAgent['auditor']).toBeCloseTo(0.02);
    expect(s.byAgent['generator']).toBeCloseTo(0.02);
  });

  it('groups by product', () => {
    const ct = new CostTracker();
    ct.add('a', 0.01, 'g', 'prod-1');
    ct.add('b', 0.02, 'g', 'prod-1');
    ct.add('c', 0.03, 'g', 'prod-2');
    const s = ct.summary();
    expect(s.byProduct['prod-1']).toBeCloseTo(0.03);
    expect(s.byProduct['prod-2']).toBeCloseTo(0.03);
  });

  it('groups by provider', () => {
    const ct = new CostTracker();
    ct.add('a', 0.01, 'gemini');
    ct.add('b', 0.02, 'imagen');
    ct.add('c', 0.01, 'gemini');
    const s = ct.summary();
    expect(s.byProvider['gemini']).toBeCloseTo(0.02);
    expect(s.byProvider['imagen']).toBeCloseTo(0.02);
  });
});
