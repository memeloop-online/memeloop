import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';

import { parseBoundedIntegerOption } from '../cliOptionParsing.js';

describe('parseBoundedIntegerOption', () => {
  it('accepts bounded safe decimal integers', () => {
    expect(parseBoundedIntegerOption('1', '--ttl-ms', 1, 300_000)).toBe(1);
    expect(parseBoundedIntegerOption('300000', '--ttl-ms', 1, 300_000)).toBe(
      300_000,
    );
    expect(parseBoundedIntegerOption('65535', '--port', 1, 65_535)).toBe(
      65_535,
    );
  });

  it.each([
    ['abc', '--ttl-ms', 1, 300_000],
    ['1.5', '--ttl-ms', 1, 300_000],
    ['1e3', '--ttl-ms', 1, 300_000],
    ['0', '--ttl-ms', 1, 300_000],
    ['300001', '--ttl-ms', 1, 300_000],
    ['70000', '--port', 1, 65_535],
    ['999', '--timeout-ms', 1_000, 3_600_000],
    ['9007199254740992', '--timeout-ms', 1_000, 3_600_000],
  ])(
    'rejects invalid value %s for %s',
    (value, optionName, minimum, maximum) => {
      expect(() => parseBoundedIntegerOption(value, optionName, minimum, maximum)).toThrow(InvalidArgumentError);
      expect(() => parseBoundedIntegerOption(value, optionName, minimum, maximum)).toThrow(`${optionName} must be an integer between ${minimum} and ${maximum}`);
    },
  );
});
