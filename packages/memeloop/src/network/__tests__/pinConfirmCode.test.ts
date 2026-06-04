import { describe, expect, it } from 'vitest';

import { computePinConfirmCode, verifyPinConfirmCode } from '../pinConfirmCode.js';

describe('computePinConfirmCode', () => {
  it('is symmetric and order-independent', async () => {
    const a = 'AAA';
    const b = 'BBB';
    expect(await computePinConfirmCode(a, b)).toBe(await computePinConfirmCode(b, a));
  });

  it('returns 6 decimal digits', async () => {
    const code = await computePinConfirmCode('pk1', 'pk2');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('verifyPinConfirmCode strips non-digits', async () => {
    const a = 'x25519-a';
    const b = 'x25519-b';
    const code = await computePinConfirmCode(a, b);
    expect(await verifyPinConfirmCode(a, b, `  ${code.slice(0, 3)}-${code.slice(3)}  `)).toBe(true);
    expect(await verifyPinConfirmCode(a, b, '000000')).toBe(false);
  });
});
