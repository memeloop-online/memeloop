import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPackedTargets, collectLocalTargets } from '../lib/check-packed-package.mjs';

test('packed target verification includes nested type export targets', () => {
  const manifest = {
    name: 'fixture-package',
    types: './dist/index.d.ts',
    exports: {
      './tools': {
        types: './dist/tools/index.d.ts',
        import: './dist/tools.js',
      },
    },
  };
  const targets = collectLocalTargets({
    types: manifest.types,
    exports: manifest.exports,
  });
  assert.deepEqual(targets, [
    'dist/index.d.ts',
    'dist/tools/index.d.ts',
    'dist/tools.js',
  ]);
  assertPackedTargets(manifest, new Set(targets));
});

test('packed target verification rejects a missing declaration target', () => {
  assert.throws(
    () => assertPackedTargets(
      { name: 'fixture-package', types: './dist/missing.d.ts' },
      new Set(['dist/index.js']),
    ),
    /fixture-package: packed entry target 'dist\/missing\.d\.ts' is missing/,
  );
});
