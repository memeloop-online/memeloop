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
  { pattern: /as\s+unknown\s+as/gu, label: 'unsafe unknown cast' },
  { pattern: /as\s+never\b/gu, label: 'never cast' },
  { pattern: /signDevicePairingInvitePayload/gu, label: 'pairing signer compatibility alias' },
  { pattern: /Libp2pWithTransportManager/gu, label: 'private transport-manager shape' },
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
  console.error('libp2p production contract audit failed:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`libp2p production contract audit passed across ${files.length} source files`);
}
