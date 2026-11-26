import { describe, expect, it } from 'vitest';

import { accountFromForm, normalizeProviderId } from '../configTuiHelpers.js';

describe('provider configuration input helpers', () => {
  it('accepts Unicode and numeric IDs after NFC normalization', () => {
    expect(normalizeProviderId('  供应商１  ')).toBe('供应商１');
    expect(normalizeProviderId('123-gateway_2')).toBe('123-gateway_2');
    expect(accountFromForm(' 供应商 ', '', []).providerId).toBe('供应商');
  });

  it('rejects empty, whitespace-only, and unsafe IDs', () => {
    expect(() => normalizeProviderId('')).toThrow(/invalid|must begin/i);
    expect(() => normalizeProviderId('  ')).toThrow(/invalid|must begin/i);
    expect(() => normalizeProviderId('../provider')).toThrow(/must begin|invalid/i);
    expect(() => normalizeProviderId('provider/name')).toThrow(/must begin|invalid/i);
  });

  it('uses a canonical default route for a manual account', () => {
    expect(accountFromForm('数字1', '', [])).toMatchObject({
      providerId: '数字1',
      providerType: 'openai-compatible',
      models: [{ modelId: 'default', wireModelId: 'default', apiMode: 'chat-completions' }],
    });
  });
});
