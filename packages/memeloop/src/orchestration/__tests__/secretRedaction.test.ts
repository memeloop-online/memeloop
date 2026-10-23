import { describe, expect, it } from 'vitest';

import { containsSecrets, redactSecrets } from '../security/secretRedaction.js';

describe('redactSecrets', () => {
  it('redacts secret-shaped keys at any depth', () => {
    const input = {
      provider: { name: 'openai', apiKey: 'sk-abcdefghijklmnop' },
      nested: [{ authorization: 'Bearer abcdef123456789' }],
      note: 'nothing here',
    };
    const redacted = redactSecrets(input);
    expect(redacted.provider.apiKey).toBe('[REDACTED]');
    expect(redacted.nested[0].authorization).toBe('[REDACTED]');
    expect(redacted.provider.name).toBe('openai');
    expect(redacted.note).toBe('nothing here');
    // Input must not be mutated.
    expect(input.provider.apiKey).toBe('sk-abcdefghijklmnop');
  });

  it('redacts secret-shaped values even under innocent keys', () => {
    const redacted = redactSecrets({ log: 'call failed with key sk-1234567890abcdef in output' });
    expect(redacted.log).toBe('call failed with key [REDACTED] in output');
  });

  it('redacts model access handles', () => {
    const redacted = redactSecrets({ message: 'handle mlh1.abc123.def456 leaked' });
    expect(redacted.message).toBe('handle [REDACTED] leaked');
  });

  it('keeps the bearer scheme while redacting the token', () => {
    const redacted = redactSecrets({ header: 'Authorization: Bearer abcdef123456789' });
    expect(redacted.header).toBe('Authorization: Bearer [REDACTED]');
  });

  it('traverses maps, sets, and arrays', () => {
    const redacted = redactSecrets({
      map: new Map([['token', 'xoxb-1234567890-abcdefghij']]),
      set: new Set(['AKIAIOSFODNN7EXAMPLE']),
      list: ['plain', 'ghp_abcdefghijklmnop1234'],
    });
    expect(redacted.map.get('token')).toBe('[REDACTED]');
    expect(Array.from(redacted.set)).toEqual(['[REDACTED]']);
    expect(redacted.list).toEqual(['plain', '[REDACTED]']);
  });

  it('supports custom patterns and replacement text', () => {
    const redacted = redactSecrets(
      { sessionCookie: 'cookie-value', other: 'safe' },
      { additionalKeyPatterns: [/cookie/i], replacement: '***' },
    );
    expect(redacted.sessionCookie).toBe('***');
    expect(redacted.other).toBe('safe');
  });
});

describe('containsSecrets', () => {
  it('detects secret-shaped keys and values', () => {
    expect(containsSecrets({ apiKey: 'anything' })).toBe(true);
    expect(containsSecrets({ text: 'sk-abcdefghijklmnop' })).toBe(true);
    expect(containsSecrets({ text: 'Bearer abcdef123456789' })).toBe(true);
    expect(containsSecrets({ nested: [{ deep: 'mlh1.abc.def' }] })).toBe(true);
  });

  it('returns false for clean values', () => {
    expect(containsSecrets({ name: 'openai', models: ['gpt-4o'], count: 3 })).toBe(false);
    expect(containsSecrets('a plain string')).toBe(false);
    expect(containsSecrets(null)).toBe(false);
    expect(containsSecrets(42)).toBe(false);
  });
});
