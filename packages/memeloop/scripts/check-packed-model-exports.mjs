import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const archive = process.argv[2];
if (!archive) throw new Error('Usage: node scripts/check-packed-model-exports.mjs <core.tgz>');
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'memeloop-packed-model-exports-'));
try {
  execFileSync('tar', ['-xzf', resolve(archive), '-C', temporaryRoot]);
  const extracted = join(temporaryRoot, 'package');
  // Dependencies are reused, but all entry points and export maps come from the archive.
  symlinkSync(join(packageRoot, 'node_modules'), join(extracted, 'node_modules'), 'junction');
  for (const condition of ['browser', 'react-native']) {
    const source = `
      import assert from 'node:assert/strict';
      import { assertAgentModelConfig, resolveAgentModelConfig } from 'memeloop';
      const selection = resolveAgentModelConfig({
        definition: {},
        hostDefault: { providerId: 'provider', modelId: 'model', parameters: { temperature: 0.4 } },
      });
      assertAgentModelConfig(selection);
      assert.deepEqual(selection, { providerId: 'provider', modelId: 'model', parameters: { temperature: 0.4 } });
      assert.throws(() => assertAgentModelConfig({ providerId: 'provider' }));
    `;
    execFileSync(process.execPath, [`--conditions=${condition}`, '--input-type=module', '--eval', source], {
      cwd: extracted,
      stdio: 'pipe',
    });
  }
  console.log('Packed browser and React Native model configuration runtime exports pass.');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
