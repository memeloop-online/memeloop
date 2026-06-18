import { describe, expect, it } from 'vitest';

import type { RJSFSchema } from '@rjsf/utils';
import { attachPromptPathAnnotations, getSchemaFromDefinition } from '../core/schemaGenerator.js';

describe('getSchemaFromDefinition', () => {
  it('returns empty object schema when promptSchema missing', () => {
    const s = getSchemaFromDefinition({});
    expect(s.type).toBe('object');
    expect(s.properties).toEqual({});
  });

  it('returns promptSchema when non-empty object', () => {
    const custom = { type: 'object' as const, title: 'T' };
    expect(getSchemaFromDefinition({ promptSchema: custom })).toEqual(custom);
  });
});

describe('attachPromptPathAnnotations', () => {
  it('returns schema unchanged when sourcePaths missing/empty', () => {
    const base: RJSFSchema = { type: 'object' };
    expect(attachPromptPathAnnotations(base, undefined)).toBe(base);
    expect(attachPromptPathAnnotations(base, {})).toBe(base);
  });

  it('appends prompt path note to description (handles existing description)', () => {
    const annotated1 = attachPromptPathAnnotations(
      { type: 'object', description: '' },
      { a: 'p1' },
    );
    expect(annotated1.description).toContain('MemeLoop prompt node paths:');
    expect(annotated1.description).toContain('"a":"p1"');

    const annotated2 = attachPromptPathAnnotations(
      { type: 'object', description: 'hello' },
      { b: 'p2' },
    );
    expect(annotated2.description).toContain('hello');
    expect(annotated2.description).toContain('"b":"p2"');
  });
});
