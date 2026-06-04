import { describe, expect, it } from 'vitest';

import { computePinConfirmCode, verifyPinConfirmCode } from '../pinConfirmCode.js';

describe('computePinConfirmCode', () => {
  it('is symmetric and order-independent', () => {
    const a = 'AAA';
    const b = 'BBB';
    expect(computePinConfirmCode(a, b)).toBe(computePinConfirmCode(b, a));
  });

  it('returns 6 decimal digits', () => {
    const code = computePinConfirmCode('pk1', 'pk2');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('verifyPinConfirmCode strips non-digits', () => {
    const a = 'x25519-a';
    const b = 'x25519-b';
    const code = computePinConfirmCode(a, b);
    expect(verifyPinConfirmCode(a, b, `  ${code.slice(0, 3)}-${code.slice(3)}  `)).toBe(true);
    expect(verifyPinConfirmCode(a, b, '000000')).toBe(false);
  });
});
