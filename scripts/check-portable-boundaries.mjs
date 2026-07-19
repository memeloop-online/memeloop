#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'packages', 'memeloop', 'src');
const CLI_SRC = join(ROOT, 'packages', 'memeloop-cli', 'src');

const NODE_BUILTINS = new Set([
  'fs', 'path', 'crypto', 'child_process', 'net', 'http', 'https',
  'os', 'tls', 'dgram', 'dns', 'readline', 'repl', 'stream',
  'timers', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads',
  'zlib', 'assert', 'buffer', 'events', 'querystring', 'string_decoder',
]);

const BANNED_IMPORTS = [
  { pattern: /^libp2p\b/, label: 'libp2p' },
  { pattern: /^@libp2p\//, label: '@libp2p/' },
  { pattern: /^@chainsafe\/libp2p/, label: '@chainsafe/libp2p' },
];

function scanDir(dir, allowedPatterns = []) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      results.push(...scanDir(full, allowedPatterns));
    } else if (entry.isFile() && /\.(ts|tsx|mjs)$/.test(entry.name)) {
      const skip = full.includes('node_modules') || full.includes('/dist/') || full.includes('/__tests__/') ||
        allowedPatterns.some((p) => p.test(full));
      if (!skip) results.push(scanFile(full));
    }
  }
  return results;
}

function scanFile(filePath) {
  const violations = [];
  const content = readFileSync(filePath, 'utf-8');
  const rel = relative(ROOT, filePath);
  for (const line of content.split('\n')) {
    const m = line.match(/from\s+['"]([^'"]+)['"]/);
    if (!m) continue;
    const spec = m[1];
    const base = spec.startsWith('node:') ? spec.slice(5) : spec;
    if (NODE_BUILTINS.has(base) && spec !== 'node:events' && spec !== 'node:stream') {
      violations.push({ file: rel, line: line.trim(), reason: `Node builtin import: ${spec}` });
    }
    for (const { pattern, label } of BANNED_IMPORTS) {
      if (pattern.test(spec)) {
        violations.push({ file: rel, line: line.trim(), reason: `Banned platform import: ${spec} (matches ${label})` });
      }
    }
  }
  return violations;
}

function main() {
  const coreAdapterPatterns = [/libp2pDeviceNetworkService/];
  const violations = scanDir(SRC, coreAdapterPatterns).flat();

  if (violations.length === 0) {
    console.log('✅ No portable-boundary violations in memeloop core.');
  } else {
    console.log(`❌ ${violations.length} violation(s) in memeloop core:\n`);
    for (const v of violations) console.log(`  ${v.file}\n    ${v.reason}`);
  }

  const cliViolations = scanDir(CLI_SRC).flat();
  if (cliViolations.length === 0) {
    console.log('✅ No unexpected violations in memeloop-cli.');
  }

  const total = violations.length;
  if (total > 0 && process.argv.includes('--ci')) {
    console.log(`\nCI check failed: ${total} violation(s).`);
    process.exit(1);
  }
}
main();
