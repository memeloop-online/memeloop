import { describe, expect, it } from 'vitest';

import { defineModifier } from '../defineModifier.js';

describe('defineModifier', () => {
  it('returns {modifierId, modifier}', () => {
    const m = (_hooks: any) => {};
    expect(defineModifier('m1', m)).toEqual({ modifierId: 'm1', modifier: m });
  });
});
