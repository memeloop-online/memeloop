import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findEmptyCatchViolations } from './checkReviewContractsLib.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(packageRoot, 'src');

function productionSourceFiles() {
  return readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name))
    .map(entry => resolve(entry.parentPath, entry.name))
    .filter(file => !file.includes(`${resolve(sourceRoot, '__tests__')}/`) && !/\.stories\.tsx?$/u.test(file));
}

const files = productionSourceFiles();
const violations = [];
const checks = [
  { pattern: /\bas unknown as\b/gu, message: 'double assertion (as unknown as)' },
  { pattern: /\bas never\b/gu, message: 'escape-hatch assertion (as never)' },
  { pattern: /\badapter\.messages\.map\s*\(/gu, message: 'unbounded adapter message render' },
];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const relative = file.slice(packageRoot.length + 1);
  for (const { pattern, message } of checks) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index ?? 0).split('\n').length;
      violations.push(`${relative}:${line} ${message}`);
    }
  }
  for (const { index, message } of findEmptyCatchViolations(source)) {
    const line = source.slice(0, index).split('\n').length;
    violations.push(`${relative}:${line} ${message}`);
  }
}

const coreTypes = readFileSync(resolve(sourceRoot, 'chat/coreTypes.ts'), 'utf8');
if (!/export type \{[^}]*\bWikiTiddlerClickData\b[^}]*\} from ['"]memeloop['"]/su.test(coreTypes)) {
  violations.push('src/chat/coreTypes.ts must re-export WikiTiddlerClickData from Core');
}

for (const file of files) {
  if (file.endsWith('/chat/coreTypes.ts')) continue;
  const source = readFileSync(file, 'utf8');
  if (/^\s*(?:export\s+)?(?:interface|type)\s+WikiTiddler(?:ClickData|ContentProjection|Attachment)\b/mu.test(source)) {
    violations.push(`${file.slice(packageRoot.length + 1)} declares a duplicate Core WikiTiddler DTO`);
  }
}

for (const file of ['src/chat/runtime/useMemeLoopRuntime.ts', 'src/native/AgentChatView.tsx']) {
  const source = readFileSync(resolve(packageRoot, file), 'utf8');
  if (!/boundedResidentMessages\s*\(/u.test(source)) violations.push(`${file} must use boundedResidentMessages before rendering`);
}

for (const file of ['src/components/ProjectSessionSidebar/index.tsx', 'src/components/ProjectSessionList/index.tsx']) {
  const source = readFileSync(resolve(packageRoot, file), 'utf8');
  if (!/max-width:\s*100%/u.test(source) && file.includes('ProjectSessionSidebar')) {
    violations.push(`${file} must cap sidebar width at its host width`);
  }
  if (!/min-width:\s*0/u.test(source)) violations.push(`${file} must allow narrow-host shrinking`);
}

if (violations.length > 0) {
  throw new Error(`React UI review contract checks failed:\n${violations.join('\n')}`);
}

console.log('React UI review contract checks passed.');
