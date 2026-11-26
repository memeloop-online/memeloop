import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPackageEntryContract,
  resolvePackageEntryTargets,
} from '../../packages/memeloop/scripts/check-zod-portable-contract.mjs';

test('Zod portability scanner follows the published Core node entry points', () => {
  const entries = assertPackageEntryContract();

  assert.match(entries.types, /[\\/]dist[\\/]index\.d\.ts$/u);
  assert.match(entries.import, /[\\/]dist[\\/]index\.js$/u);
  assert.match(entries.require, /[\\/]dist[\\/]index\.cjs$/u);
});

test('Zod portability scanner rejects a drifted root types export', () => {
  assert.throws(
    () => resolvePackageEntryTargets({
      name: 'fixture-package',
      types: 'dist/index.d.ts',
      exports: {
        '.': {
          node: {
            types: './dist/other.d.ts',
            import: './dist/index.js',
            require: './dist/index.cjs',
          },
        },
      },
    }),
    /manifest\.types .* must match exports\["\."\]\.node\.types/u,
  );
});
