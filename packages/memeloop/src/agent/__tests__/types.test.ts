import { describe, expect, it } from 'vitest';

import { assertAgentModelConfig, assertModelAssignments, type ModelAssignments, normalizeModelAssignments } from '../types.js';

describe('assertAgentModelConfig', () => {
  it('exposes one canonical model assignment shape to hosts', () => {
    const assignments: ModelAssignments = {
      default: {
        providerId: 'provider',
        modelId: 'model',
        parameters: { maxOutputTokens: 8_192, reasoningEffort: 'high' },
      },
      embedding: { providerId: 'provider', modelId: 'embedding-model' },
    };
    expect(assignments.default?.providerId).toBe('provider');
    expect(assignments.embedding?.modelId).toBe('embedding-model');
  });

  it.each(['minimal', 'low', 'medium', 'high'] as const)('accepts canonical reasoning effort %s', reasoningEffort => {
    expect(() => {
      assertAgentModelConfig({
        providerId: 'provider',
        modelId: 'model',
        parameters: { reasoningEffort },
      });
    }).not.toThrow();
  });

  it('rejects an unsupported reasoning effort', () => {
    expect(() => {
      assertAgentModelConfig({
        providerId: 'provider',
        modelId: 'model',
        parameters: { reasoningEffort: 'maximum' },
      });
    }).toThrow('invalid agent model reasoningEffort');
  });
});

describe('ModelAssignments', () => {
  it('validates and detaches every canonical route', () => {
    const input: ModelAssignments = {
      default: {
        providerId: '提供方',
        modelId: 'model/default',
        parameters: { reasoningEffort: 'high' },
      },
      embedding: { providerId: '0provider', modelId: 'embed' },
    };
    assertModelAssignments(input);
    const normalized = normalizeModelAssignments(input);
    expect(normalized).toEqual(input);
    expect(normalized).not.toBe(input);
    expect(normalized.default).not.toBe(input.default);
    expect(normalized.default?.parameters).not.toBe(input.default?.parameters);
  });

  it('rejects renamed and unknown assignment fields', () => {
    expect(() => {
      assertModelAssignments({
        default: { provider: 'openai', model: 'gpt' },
      });
    }).toThrow('invalid agent modelConfig fields');
    expect(() => {
      assertModelAssignments({
        default: { providerId: 'openai', modelId: 'gpt' },
        modelParameters: {},
      });
    }).toThrow('invalid model assignment fields');
  });
});
