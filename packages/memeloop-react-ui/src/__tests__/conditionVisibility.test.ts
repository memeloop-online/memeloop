import { describe, expect, it } from 'vitest';

import { rjsfFieldPathToSegments, shouldShowConditionalField } from '../core/conditionVisibility.js';

describe('rjsfFieldPathToSegments', () => {
  it('preserves nested array segments from the public RJSF path', () => {
    expect(rjsfFieldPathToSegments(['prompts', 0, 'children', 1])).toEqual(['prompts', '0', 'children', '1']);
  });

  it('preserves property names that contain underscores', () => {
    expect(rjsfFieldPathToSegments(['model_config', 0])).toEqual(['model_config', '0']);
  });

  it('parses an explicitly dotted path', () => {
    expect(rjsfFieldPathToSegments('root.model_config.max_tokens')).toEqual(['model_config', 'max_tokens']);
  });

  it('does not guess underscore-delimited DOM ids', () => {
    expect(rjsfFieldPathToSegments('root_model_config_max_tokens')).toEqual(['root_model_config_max_tokens']);
  });

  it('rejects malformed paths and invalid array segments', () => {
    expect(rjsfFieldPathToSegments('root..value')).toEqual([]);
    expect(rjsfFieldPathToSegments(['cfg', -1])).toEqual([]);
  });
});

describe('shouldShowConditionalField', () => {
  it('reads dependsOn from the parent of a canonical path', () => {
    const root = {
      model_config: { mode: 'advanced' },
    };
    const show = shouldShowConditionalField(
      { dependsOn: 'mode', showWhen: 'advanced' },
      root,
      ['model_config', 'max_tokens'],
    );
    expect(show).toBe(true);
  });

  it('returns true when condition/rootFormData missing (no gating)', () => {
    expect(shouldShowConditionalField(undefined, undefined, undefined)).toBe(true);
    expect(shouldShowConditionalField({ dependsOn: 'x', showWhen: '1' }, undefined, undefined)).toBe(true);
  });

  it('supports showWhen array and hideWhen inversion', () => {
    const root = { cfg: { mode: 'b' } };
    expect(
      shouldShowConditionalField(
        { dependsOn: 'mode', showWhen: ['a', 'b'] },
        root,
        ['cfg', 'value'],
      ),
    ).toBe(true);

    expect(
      shouldShowConditionalField(
        { dependsOn: 'mode', showWhen: ['a', 'b'], hideWhen: true },
        root,
        ['cfg', 'value'],
      ),
    ).toBe(false);
  });

  it("returns false when dependent value doesn't match (and hideWhen=false)", () => {
    const root = { cfg: { mode: 'x' } };
    expect(
      shouldShowConditionalField(
        { dependsOn: 'mode', showWhen: 'y' },
        root,
        ['cfg', 'value'],
      ),
    ).toBe(false);
  });

  it('treats missing/invalid parent as undefined dependent value', () => {
    const root = { cfg: 'not-object' };
    expect(
      shouldShowConditionalField(
        { dependsOn: 'mode', showWhen: 'y' },
        root,
        ['cfg', 'value'],
      ),
    ).toBe(false);
  });

  it('fails closed for malformed or missing paths when form data is present', () => {
    const root = { cfg: { mode: 'advanced' } };
    expect(shouldShowConditionalField({ dependsOn: 'mode', showWhen: 'advanced' }, root, 'root_cfg_value')).toBe(false);
    expect(shouldShowConditionalField({ dependsOn: 'mode', showWhen: 'advanced' }, root, undefined)).toBe(false);
  });
});
