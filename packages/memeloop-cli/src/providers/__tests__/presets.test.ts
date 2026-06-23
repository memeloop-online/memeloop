import { describe, expect, it } from 'vitest';

import { findPreset, loadPresets } from '../presets.js';

describe('presets', () => {
  it('loadPresets returns non-empty list of known providers', () => {
    const presets = loadPresets();
    expect(presets.length).toBeGreaterThanOrEqual(8);
    // Every preset has required fields
    for (const p of presets) {
      expect(typeof p.name).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
      expect(typeof p.baseUrl).toBe('string');
      expect(p.baseUrl.startsWith('https://')).toBe(true);
      expect(typeof p.apiKeyLink).toBe('string');
      expect(Array.isArray(p.models)).toBe(true);
      expect(p.models.length).toBeGreaterThan(0);
      for (const m of p.models) {
        expect(typeof m.id).toBe('string');
        expect(typeof m.name).toBe('string');
        expect(typeof m.context).toBe('number');
        expect(typeof m.output).toBe('number');
      }
    }
  });

  it('findPreset returns correct preset by name (case-insensitive)', () => {
    const openai = findPreset('openai');
    expect(openai).toBeDefined();
    expect(openai!.name).toBe('OpenAI');
    expect(openai!.baseUrl).toContain('openai.com');
    expect(openai!.models.some((m) => m.id === 'gpt-4o')).toBe(true);

    const anthropic = findPreset('Anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic!.name).toBe('Anthropic');

    const deepseek = findPreset('DEEPSEEK');
    expect(deepseek).toBeDefined();
    expect(deepseek!.name).toBe('DeepSeek');
  });

  it('findPreset returns undefined for unknown name', () => {
    expect(findPreset('NonexistentCorp')).toBeUndefined();
    expect(findPreset('')).toBeUndefined();
  });

  it('every preset has at least one model', () => {
    const presets = loadPresets();
    for (const p of presets) {
      expect(p.models.length).toBeGreaterThanOrEqual(1);
    }
  });
});
