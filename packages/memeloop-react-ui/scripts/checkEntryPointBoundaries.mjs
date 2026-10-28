import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));

function dependencyGraph(entry) {
  const pending = [resolve(packageRoot, entry)];
  const visited = new Set();
  const external = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    const matches = [
      ...source.matchAll(/\b(?:from\s+|import\s+)["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\(["']([^"']+)["']\)/g),
    ];
    for (const match of matches) {
      const specifier = match[1];
      if (!specifier) continue;
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
      else external.add(specifier);
    }
  }
  return external;
}

function assertBoundary(entry, forbidden) {
  const dependencies = dependencyGraph(entry);
  const leaked = [...dependencies].filter(dependency =>
    forbidden.some(prefix => dependency === prefix || dependency.startsWith(`${prefix}/`))
  );
  if (leaked.length > 0) throw new Error(`${entry} unexpectedly loads: ${leaked.join(', ')}`);
  return dependencies;
}

for (const [subpath, definition] of Object.entries(manifest.exports)) {
  for (const target of Object.values(definition)) {
    if (!existsSync(resolve(packageRoot, target))) throw new Error(`Missing public export ${subpath}: ${target}`);
  }
}

assertBoundary('dist/index.js', ['@rjsf', 'react-native']);
assertBoundary('dist/index.cjs', ['@rjsf', 'react-native']);
assertBoundary('dist/agent/index.js', ['@rjsf', 'material-ui-cron', 'react-native']);
assertBoundary('dist/agent/index.cjs', ['@rjsf', 'material-ui-cron', 'react-native']);
assertBoundary('dist/agent/core.js', ['@assistant-ui', '@mui', '@rjsf', 'material-ui-cron', 'react-native']);
assertBoundary('dist/agent/core.cjs', ['@assistant-ui', '@mui', '@rjsf', 'material-ui-cron', 'react-native']);
assertBoundary('dist/agent/web.js', ['@assistant-ui', '@mui', '@rjsf', 'material-ui-cron', 'react-native']);
assertBoundary('dist/agent/web.cjs', ['@assistant-ui', '@mui', '@rjsf', 'material-ui-cron', 'react-native']);
assertBoundary('dist/chat/index.js', ['@rjsf', 'react-native']);
assertBoundary('dist/chat/index.cjs', ['@rjsf', 'react-native']);
assertBoundary('dist/chat/core.js', ['@assistant-ui', '@mui', '@rjsf', 'material-ui-cron', 'react-native']);
assertBoundary('dist/chat/core.cjs', ['@assistant-ui', '@mui', '@rjsf', 'material-ui-cron', 'react-native']);
assertBoundary('dist/agent/scheduling/core.js', ['@assistant-ui', '@mui', '@rjsf', 'material-ui-cron', 'react', 'react-native']);
assertBoundary('dist/agent/scheduling/core.cjs', ['@assistant-ui', '@mui', '@rjsf', 'material-ui-cron', 'react', 'react-native']);
assertBoundary('dist/native/index.js', ['@assistant-ui', '@mui', '@rjsf', 'material-ui-cron']);
assertBoundary('dist/native/index.cjs', ['@assistant-ui', '@mui', '@rjsf', 'material-ui-cron']);

const requireFromPackage = createRequire(resolve(packageRoot, 'scripts', 'cjs-resolution-probe.cjs'));
for (const subpath of ['chat/core', 'agent/core', 'agent/scheduling/core']) {
  const loaded = requireFromPackage(`@memeloop/react-ui/${subpath}`);
  if (loaded === null || typeof loaded !== 'object' || Object.keys(loaded).length === 0) {
    throw new Error(`CJS self-resolution returned no exports for ${subpath}`);
  }
}

const nativeFormsDeclaration = readFileSync(resolve(packageRoot, 'dist/native/forms.d.ts'), 'utf8');
if (!nativeFormsDeclaration.includes("from '@rjsf/utils'")) {
  throw new Error('Native forms declarations do not reference their required RJSF peer');
}

const promptDependencies = dependencyGraph('dist/agent/prompts/index.js');
for (const expected of ['@rjsf/mui', '@rjsf/validator-ajv8']) {
  if (!promptDependencies.has(expected)) throw new Error(`Prompt entrypoint does not load required peer ${expected}`);
}

const schedulingDependencies = dependencyGraph('dist/agent/scheduling/index.js');
if (!schedulingDependencies.has('material-ui-cron')) {
  throw new Error('Scheduling entrypoint does not load material-ui-cron');
}

for (const [file, forbiddenPatterns] of [
  ['dist/chat/core.d.ts', [/\bFile\b/u, /\bDataTransfer\b/u, /@rjsf/u, /react-native/u]],
  ['dist/agent/core.d.ts', [/\bFile\b/u, /\bDataTransfer\b/u, /@mui/u, /@rjsf/u, /react-native/u]],
  ['dist/native/index.d.ts', [/@rjsf/u, /material-ui-cron/u, /@assistant-ui/u]],
  ['dist/agent/scheduling/core.d.ts', [/@mui/u, /@rjsf/u, /material-ui-cron/u, /react-native/u]],
]) {
  const declaration = readFileSync(resolve(packageRoot, file), 'utf8');
  const leaked = forbiddenPatterns.filter(pattern => pattern.test(declaration)).map(pattern => pattern.source);
  if (leaked.length > 0) throw new Error(`${file} leaks forbidden declaration tokens: ${leaked.join(', ')}`);
}

for (const peer of [
  '@assistant-ui/react',
  '@emotion/react',
  '@emotion/styled',
  '@mui/icons-material',
  '@mui/material',
]) {
  if (!manifest.peerDependencies?.[peer]) throw new Error(`Missing peer dependency ${peer}`);
  if (manifest.peerDependenciesMeta?.[peer]?.optional === true) {
    throw new Error(`Root entrypoint peer ${peer} must be required`);
  }
}

for (const peer of [
  '@rjsf/core',
  '@rjsf/mui',
  '@rjsf/utils',
  '@rjsf/validator-ajv8',
  'material-ui-cron',
  'react-dom',
  'react-native',
  'react-native-gifted-chat',
  'react-native-paper',
]) {
  if (!manifest.peerDependencies?.[peer]) throw new Error(`Missing peer dependency ${peer}`);
  if (manifest.peerDependenciesMeta?.[peer]?.optional !== true) throw new Error(`Peer ${peer} must be optional`);
}

console.log('Public export and platform boundary checks passed.');
