import { describe, expect, it } from 'vitest';

import type { SchemaWithUiSchema } from '../core/index.js';
import { buildUiSchema } from '../core/uiSchemaBuilder.js';

describe('buildUiSchema', () => {
  it('returns overrides when schema is undefined/null', () => {
    expect(buildUiSchema(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(buildUiSchema(null, { a: 1 })).toEqual({ a: 1 });
  });

  it('merges schema.uiSchema with overrides (overrides win)', () => {
    const definition: SchemaWithUiSchema = {
      uiSchema: { 'ui:order': ['b', 'a'], a: { 'ui:placeholder': 'x' } },
    };
    const ui = buildUiSchema(definition, { a: { 'ui:placeholder': 'y' } });

    expect(ui['ui:order']).toEqual(['b', 'a']);
    expect(ui.a?.['ui:placeholder']).toBe('y');
  });
});
