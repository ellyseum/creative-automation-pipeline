/**
 * Brief schema validation tests — ensures malformed YAML fails fast
 * with useful errors rather than corrupting downstream agents.
 */

import { describe, it, expect } from 'vitest';
import { BriefSchema } from './brief.js';

describe('BriefSchema', () => {
  // Minimal valid brief — the smallest input that should parse
  const validBrief = {
    brand: {
      id: 'test-brand',
      name: 'Test Brand',
      logo: 'assets/logo.png',
      palette: ['#FF0000', '#000000'],
    },
    campaign: { name: 'Test Campaign', message: 'Buy now' },
    region: 'en-US',
    audience: 'everyone',
    products: [
      { id: 'prod-a', name: 'Product A', description: 'First product' },
      { id: 'prod-b', name: 'Product B', description: 'Second product' },
    ],
  };

  it('accepts a valid brief', () => {
    const result = BriefSchema.parse(validBrief);
    expect(result.brand.id).toBe('test-brand');
    expect(result.products).toHaveLength(2);
  });

  it('accepts optional fields', () => {
    const withOptionals = {
      ...validBrief,
      brand: { ...validBrief.brand, tone: 'energetic', fonts: { display: 'font.ttf' } },
      campaign: { ...validBrief.campaign, mood_reference: 'mood.jpg' },
      products: [
        { ...validBrief.products[0], hero_asset: 'hero.jpg' },
        validBrief.products[1],
      ],
      aspect_ratios: ['1:1', '9:16'],
    };
    const result = BriefSchema.parse(withOptionals);
    expect(result.brand.tone).toBe('energetic');
    expect(result.aspect_ratios).toEqual(['1:1', '9:16']);
  });

  it('rejects brief with fewer than 2 products', () => {
    const oneProd = { ...validBrief, products: [validBrief.products[0]] };
    expect(() => BriefSchema.parse(oneProd)).toThrow();
  });

  it('rejects invalid hex colors in palette', () => {
    const badPalette = {
      ...validBrief,
      brand: { ...validBrief.brand, palette: ['not-a-color'] },
    };
    expect(() => BriefSchema.parse(badPalette)).toThrow();
  });

  it('rejects product IDs with special characters', () => {
    const badId = {
      ...validBrief,
      products: [
        { id: 'has spaces', name: 'Bad', description: 'nope' },
        validBrief.products[1],
      ],
    };
    expect(() => BriefSchema.parse(badId)).toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => BriefSchema.parse({})).toThrow();
    expect(() => BriefSchema.parse({ brand: validBrief.brand })).toThrow();
  });
});
