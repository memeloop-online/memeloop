import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const runtime = await import('../dist/index.js');
assert.equal(
  runtime.MEMELOOP_CLI_VERSION,
  manifest.version,
  'Built SDK version differs from package.json; rebuild before packing',
);
const output = execFileSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--version'], {
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
});
assert.equal(output.trim(), manifest.version, 'Built CLI --version differs from package.json');
console.log(`Built SDK and CLI versions match memeloop-cli@${manifest.version}.`);
