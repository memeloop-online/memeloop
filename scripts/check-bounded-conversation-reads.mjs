import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const targets = [
  'packages/memeloop/src/runtime.ts',
  'packages/memeloop/src/agent-management',
  'packages/memeloop/src/device-network',
  'packages/memeloop/src/loopAPI',
  'packages/memeloop/src/sync',
  'packages/memeloop-cli/src/runtime',
  'packages/memeloop-cli/src/sessions.ts',
];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs']);
const forbidden = /\.getMessages\s*\(/gu;

async function sourceFiles(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return sourceExtensions.has(extname(path)) ? [path] : [];
  const files = [];
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(child);
  }
  return files;
}

const files = (await Promise.all(targets.map(target => sourceFiles(join(repositoryRoot, target))))).flat();
const violations = [];
for (const path of files) {
  const source = await readFile(path, 'utf8');
  for (const match of source.matchAll(forbidden)) {
    const line = source.slice(0, match.index).split('\n').length;
    violations.push(`${relative(repositoryRoot, path)}:${line}`);
  }
}

if (violations.length > 0) {
  console.error('Unbounded conversation reads are forbidden in runtime/preview/sync code:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Bounded conversation read audit passed across ${files.length} source files`);
}
