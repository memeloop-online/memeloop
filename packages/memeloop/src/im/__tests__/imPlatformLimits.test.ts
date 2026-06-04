import { describe, expect, it } from 'vitest';

import { imPlatformMaxMessageChars } from '../imPlatformLimits.js';

/** Plan §20.6.1 platform caps (documentation parity). */
describe('imPlatformMaxMessageChars', () => {
  it('matches v8 documented limits', () => {
    expect(imPlatformMaxMessageChars('telegram')).toBe(4096);
    expect(imPlatformMaxMessageChars('discord')).toBe(2000);
    expect(imPlatformMaxMessageChars('qq')).toBe(4500);
    expect(imPlatformMaxMessageChars('wecom')).toBe(2048);
    expect(imPlatformMaxMessageChars('lark')).toBe(4096);
    expect(imPlatformMaxMessageChars('slack')).toBe(4000);
  });
});
