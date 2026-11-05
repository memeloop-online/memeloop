import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = 'virtual:browser-script-editor';
const modules = [];

// Resolve the published UI and Core browser conditions, as the Electron
// renderer does. Node-condition unit tests cannot detect missing browser exports.
const bundle = await build({
  configFile: false,
  root,
  logLevel: 'silent',
  plugins: [{
    name: 'browser-editor-fixture',
    resolveId(id) {
      if (id === entry) return id;
    },
    load(id) {
      if (id === entry) return `export { AgentLoopScriptEditor } from ${JSON.stringify(resolve(root, 'dist/web/index.js').replaceAll('\\', '/'))};`;
    },
    generateBundle() {
      modules.push(...this.getModuleIds());
    },
  }],
  build: {
    write: false,
    minify: false,
    rollupOptions: {
      input: entry,
      preserveEntrySignatures: 'strict',
      external: id => !id.startsWith('.') && !id.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(id)
        && id !== entry && id !== 'memeloop' && !id.startsWith('\0'),
      output: { format: 'es' },
    },
  },
});

const outputs = Array.isArray(bundle) ? bundle.flatMap(result => result.output) : bundle.output;
assert.ok(outputs.some(output => output.type === 'chunk' && output.exports.includes('AgentLoopScriptEditor')),
  'The browser bundle retains the executable editor component');
assert.ok(modules.some(id => /memeloop[/\\]dist[/\\]browser\.js$/u.test(id)), 'Core browser entry was selected');
assert.equal(modules.some(id => id.startsWith('node:') || /nodeAgentLoopModuleImporter|memeloop-cli|libp2p/u.test(id)), false,
  'Script editor includes portable source data only');
console.log('Shared script editor bundles with Core browser exports.');
