#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'packages', 'memeloop', 'src');
const CORE_PACKAGE_JSON = join(ROOT, 'packages', 'memeloop', 'package.json');
const CLI_SRC = join(ROOT, 'packages', 'memeloop-cli', 'src');
const REACT_UI_SRC = join(ROOT, 'packages', 'memeloop-react-ui', 'src');

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

const PROCESS_ALLOWLIST = [/scripts\//, /check-portable-boundaries/];
const DYNAMIC_IMPORT_ALLOWLIST = [/scriptLoader\.ts/];
// This generated module contains only a JSON string plus JSON.parse. Catalog
// model IDs are data and may legitimately contain text such as "global.foo".
const PORTABLE_DATA_ALLOWLIST = [/modelCatalog\/embeddedCatalog\.generated\.ts$/];

function scanDir(dir, allowedPatterns = []) {
  const results = [];
  if (!existsSync(dir)) return results;
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
  const lines = content.split('\n');
  const isProcessAllowed = PROCESS_ALLOWLIST.some((p) => p.test(rel));

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    const importMatch = trimmed.match(/(?:from|import)\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      const spec = importMatch[1];
      const base = spec.startsWith('node:') ? spec.slice(5) : spec;
      if (NODE_BUILTINS.has(base)) {
        violations.push({ file: rel, line: trimmed, reason: 'Node builtin import: ' + spec });
      }
      for (const { pattern, label } of BANNED_IMPORTS) {
        if (pattern.test(spec)) {
          violations.push({ file: rel, line: trimmed, reason: 'Banned platform import: ' + spec + ' (matches ' + label + ')' });
        }
      }
    }

    // Detect non-literal dynamic import() (defeats admission control)
    const dynMatch = trimmed.match(/import\s*\(\s*([^)]+)\s*\)/);
    if (dynMatch) {
      const arg = dynMatch[1].trim();
      const isAllowed = DYNAMIC_IMPORT_ALLOWLIST.some((p) => p.test(rel));
      if (!isAllowed && !arg.startsWith("'") && !arg.startsWith('"') && !arg.startsWith('`')) {
        violations.push({ file: rel, line: trimmed, reason: 'Non-literal dynamic import() — defeats admission control: ' + arg });
      }
    }

    // Detect raw process.env in portable core
    if (!isProcessAllowed && /\bprocess\.env\b/.test(trimmed)) {
      violations.push({ file: rel, line: trimmed, reason: 'Raw process.env access in portable core' });
    }

    // Detect raw global usage (not globalThis)
    // Match the legacy global object itself, but not an ordinary property such
    // as `budget.global.events`.
    if (!isProcessAllowed && /(^|[^\w$.])global\.\w/.test(trimmed) && !/\bglobalThis\b/.test(trimmed)) {
      violations.push({ file: rel, line: trimmed, reason: 'Raw global usage in portable core' });
    }

    if (/\bBuffer\b/.test(trimmed)) {
      violations.push({ file: rel, line: trimmed, reason: 'Node Buffer usage in portable core; use Uint8Array' });
    }
  }
  return violations;
}

function checkCorePackageDependencies() {
  const manifest = JSON.parse(readFileSync(CORE_PACKAGE_JSON, 'utf8'));
  const installed = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  };
  const forbidden = [
    /^@ai-sdk\//,
    /^@chainsafe\/libp2p/,
    /^@libp2p\//,
    /^@multiformats\/multiaddr$/,
    /^libp2p$/,
    /^etcd3$/,
    /^better-sqlite3$/,
    /^dockerode$/,
    /^@kubernetes\//,
    /^ollama-ai-provider/,
  ];
  return Object.keys(installed)
    .filter((dependency) => forbidden.some((pattern) => pattern.test(dependency)))
    .map((dependency) => ({
      file: relative(ROOT, CORE_PACKAGE_JSON),
      line: dependency,
      reason: `Node transport/provider/backend dependency '${dependency}' must live in a host package or optional peer`,
    }));
}

function checkReactUiScopeGuard() {
  const issues = [];
  if (!existsSync(SRC)) return issues;
  function collectFiles(dir) {
    const files = [];
    if (!existsSync(dir)) return files;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        files.push(...collectFiles(full));
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        if (!full.includes('/dist/') && !full.includes('/__tests__/')) {
          files.push(full);
        }
      }
    }
    return files;
  }
  const coreFiles = collectFiles(SRC);
  for (const file of coreFiles) {
    const content = readFileSync(file, 'utf-8');
    if (/from\s+['"][^'"]*memeloop-react-ui/.test(content)) {
      issues.push({ file: relative(ROOT, file), line: '', reason: 'Core imports memeloop-react-ui — violates scope guard' });
    }
  }
  return issues;
}

function main() {
  const packageViolations = checkCorePackageDependencies();
  const violations = [...scanDir(SRC, PORTABLE_DATA_ALLOWLIST).flat(), ...packageViolations];
  if (violations.length === 0) {
    console.log('No portable-boundary violations in memeloop core.');
  } else {
    console.log(violations.length + ' violation(s) in memeloop core:\n');
    for (const v of violations) console.log('  ' + v.file + '\n    ' + v.reason);
  }

  const cliViolations = scanDir(CLI_SRC).flat();
  if (cliViolations.length === 0) {
    console.log('No unexpected violations in memeloop-cli.');
  }

  const reactUiIssues = checkReactUiScopeGuard();
  if (reactUiIssues.length === 0) {
    console.log('memeloop-react-ui scope guard: no core->react-ui imports.');
  } else {
    console.log(reactUiIssues.length + ' react-ui scope violation(s):\n');
    for (const v of reactUiIssues) console.log('  ' + v.file + '\n    ' + v.reason);
  }

  const total = violations.length + reactUiIssues.length;
  if (total > 0 && process.argv.includes('--ci')) {
    console.log('\nCI check failed: ' + total + ' violation(s).');
    process.exit(1);
  }
}
main();
