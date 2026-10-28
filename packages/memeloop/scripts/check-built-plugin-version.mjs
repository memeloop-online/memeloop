import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const esm = await import('../dist/index.js');
const cjs = createRequire(import.meta.url)('../dist/index.cjs');
for (const [format, runtime] of [['ESM', esm], ['CJS', cjs]]) {
  assert.equal(
    runtime.MEMELOOP_PLUGIN_API_VERSION,
    manifest.version,
    `${format} plugin runtime version differs from package.json; rebuild before packing`,
  );
}
console.log(`ESM and CJS plugin runtime versions match memeloop@${manifest.version}.`);
