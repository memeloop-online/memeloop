import { describe, expect, it } from 'vitest';

import { ALL_CATEGORIES, getCategoryConfig, isTaskCategory, resolveCategory } from '../categories.js';
import type { TaskCategory } from '../categories.js';

describe('categories', () => {
  describe('ALL_CATEGORIES', () => {
    it('contains all 7 expected categories', () => {
      expect(ALL_CATEGORIES).toHaveLength(7);
      expect(ALL_CATEGORIES).toContain('visual-engineering');
      expect(ALL_CATEGORIES).toContain('ultrabrain');
      expect(ALL_CATEGORIES).toContain('artistry');
      expect(ALL_CATEGORIES).toContain('quick');
      expect(ALL_CATEGORIES).toContain('unspecified-low');
      expect(ALL_CATEGORIES).toContain('unspecified-high');
      expect(ALL_CATEGORIES).toContain('writing');
    });
  });

  describe('getCategoryConfig', () => {
    it('returns config for each valid category', () => {
      for (const cat of ALL_CATEGORIES) {
        const config = getCategoryConfig(cat);
        expect(config).toBeDefined();
        expect(typeof config.model).toBe('string');
        expect(typeof config.temperature).toBe('number');
        expect(config.temperature).toBeGreaterThanOrEqual(0);
        expect(config.temperature).toBeLessThanOrEqual(1);
        expect(typeof config.description).toBe('string');
        expect(config.description.length).toBeGreaterThan(0);
      }
    });

    it('returns a new object each call (no reference sharing)', () => {
      const a = getCategoryConfig('quick');
      const b = getCategoryConfig('quick');
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it('has expected temperature ranges per category', () => {
      // creative categories should have higher temps
      expect(getCategoryConfig('artistry').temperature).toBeGreaterThan(0.5);
      expect(getCategoryConfig('writing').temperature).toBeGreaterThan(0.5);

      // deterministic categories should have lower temps
      expect(getCategoryConfig('ultrabrain').temperature).toBeLessThan(0.3);
      expect(getCategoryConfig('quick').temperature).toBeLessThan(0.3);
      expect(getCategoryConfig('visual-engineering').temperature).toBeLessThan(0.5);
    });

    it('throws for unknown category', () => {
      expect(() => getCategoryConfig('nonexistent' as TaskCategory)).toThrow(
        /Unknown task category/,
      );
    });
  });

  describe('isTaskCategory', () => {
    it('returns true for valid categories', () => {
      expect(isTaskCategory('visual-engineering')).toBe(true);
      expect(isTaskCategory('ultrabrain')).toBe(true);
      expect(isTaskCategory('artistry')).toBe(true);
      expect(isTaskCategory('quick')).toBe(true);
      expect(isTaskCategory('unspecified-low')).toBe(true);
      expect(isTaskCategory('unspecified-high')).toBe(true);
      expect(isTaskCategory('writing')).toBe(true);
    });

    it('returns false for invalid categories', () => {
      expect(isTaskCategory('')).toBe(false);
      expect(isTaskCategory('unknown')).toBe(false);
      expect(isTaskCategory('build')).toBe(false);
      expect(isTaskCategory('explore')).toBe(false);
    });
  });

  describe('resolveCategory', () => {
    it('returns config for valid categories', () => {
      const config = resolveCategory('writing');
      expect(config.description).toContain('Documentation');
    });

    it('falls back to unspecified-low for unknown categories', () => {
      const config = resolveCategory('unknown-stuff');
      expect(config).toEqual(getCategoryConfig('unspecified-low'));
    });

    it('falls back to unspecified-low for empty string', () => {
      const config = resolveCategory('');
      expect(config).toEqual(getCategoryConfig('unspecified-low'));
    });
  });
});
