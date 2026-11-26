import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = join(packageRoot, 'src');
const sourceExtensions = new Set(['.ts', '.tsx', '.mjs']);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'dist' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

const forbidden = [
  { pattern: /AttachmentReference\s+as\s+AttachmentRef/gu, label: 'AttachmentRef compatibility alias' },
  { pattern: /interface\s+(?:WikiInfo|NodeProtocolCapabilities|NodeStatus|KnownNodeEntry)\b/gu, label: 'local Desktop compatibility wire DTO' },
  { pattern: /Compatibility wire types/gu, label: 'compatibility wire type boundary' },
];

const files = await sourceFiles(sourceRoot);
const violations = [];
for (const path of files) {
  const source = await readFile(path, 'utf8');
  for (const rule of forbidden) {
    for (const match of source.matchAll(rule.pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${relative(packageRoot, path)}:${line} (${rule.label})`);
    }
  }
}

if (violations.length > 0) {
  console.error('protocol production contract audit failed:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`protocol production contract audit passed across ${files.length} source files`);
}
